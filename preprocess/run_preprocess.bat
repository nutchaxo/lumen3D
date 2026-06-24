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
set "PP_VERSION=0.14.0"
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

echo.
echo !DIM!--------------------------------------------------------------------------------!R!
echo    !BOLD!Recapitulatif!R!
echo      Python : !PY!
echo      Entree : !INPUT!
echo      Sortie : !OUTPUT!
if defined FILTER (echo      Filtre : !FILTER!) else (echo      Filtre : tous les fichiers)
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
if defined FILTER (
    %PY% "!WORK!\!ENTRY!" --input "!INPUT!" --output "!OUTPUT!" --only "!FILTER!"
) else (
    %PY% "!WORK!\!ENTRY!" --input "!INPUT!" --output "!OUTPUT!"
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
:: ---- [0] run_preprocess.py (11806 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGZubWF0Y2gKaW1w
#0#b3J0IGpzb24KaW1wb3J0IG9zCmltcG9ydCBzaHV0aWwKaW1wb3J0IHNpZ25hbAppbXBvcnQgc3Vi
#0#cHJvY2VzcwppbXBvcnQgc3lzCmltcG9ydCB0cmFjZWJhY2sKZnJvbSBkYXRldGltZSBpbXBvcnQg
#0#ZGF0ZXRpbWUKZnJvbSBwYXRobGliIGltcG9ydCBQYXRoCmltcG9ydCBudW1weSBhcyBucApmcm9t
#0#IFBJTCBpbXBvcnQgSW1hZ2UKCl9fdmVyc2lvbl9fID0gIjAuMTQuMCIKCiMg4pSA4pSAIFBhdGhz
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
#0#ZWYgcnVuX3N0ZXAoc2NyaXB0X25hbWU6IHN0ciwgKmFyZ3MpIC0+IE5vbmU6CiAgICBnbG9iYWwg
#0#X2N1cnJlbnRfcHJvYwogICAgY21kID0gW1BZVEhPTl9FWEUsIHN0cihTQ1JJUFRfRElSIC8gc2Ny
#0#aXB0X25hbWUpLCAqYXJnc10KICAgIHByaW50KF9kaW0oZiIgICAtIHtzY3JpcHRfbmFtZX0iKSkK
#0#ICAgIHByb2MgPSBzdWJwcm9jZXNzLlBvcGVuKGNtZCwgKipfU1RFUF9TUEFXTikKICAgIF9jdXJy
#0#ZW50X3Byb2MgPSBwcm9jCiAgICB0cnk6CiAgICAgICAgcmV0ID0gcHJvYy53YWl0KCkKICAgIGV4
#0#Y2VwdCBLZXlib2FyZEludGVycnVwdDoKICAgICAgICAjIENvbmZpcm1lZCBhYm9ydCBkdXJpbmcg
#0#dGhpcyBzdGVwOiB0ZWFyIGRvd24gdGhlIHN0ZXAgYW5kIGl0cyB3b3JrZXIgcG9vbC4KICAgICAg
#0#ICBfa2lsbF90cmVlKHByb2MpCiAgICAgICAgcmFpc2UKICAgIGZpbmFsbHk6CiAgICAgICAgX2N1
#0#cnJlbnRfcHJvYyA9IE5vbmUKICAgIGlmIHJldCAhPSAwOgogICAgICAgIHJhaXNlIHN1YnByb2Nl
#0#c3MuQ2FsbGVkUHJvY2Vzc0Vycm9yKHJldCwgY21kKQoKZGVmIHByb2Nlc3NfaW1zX2ZpbGUoaW1z
#0#X3BhdGg6IFBhdGgsIG91dHB1dF9yb290OiBQYXRoLCBpZHg6IGludCA9IDAsIHRvdGFsOiBpbnQg
#0#PSAwKSAtPiBOb25lOgogICAgZGF0YXNldF9uYW1lID0gaW1zX3BhdGguc3RlbQogICAgY291bnRl
#0#ciA9IGYiW3tpZHh9L3t0b3RhbH1dICIgaWYgdG90YWwgZWxzZSAiIgogICAgcHJpbnQoKQogICAg
#0#cHJpbnQoX2hkcihmIj4+IHtjb3VudGVyfXtkYXRhc2V0X25hbWV9IikpCiAgICBwcmludChfZGlt
#0#KGYiICAgc291cmNlIDoge2ltc19wYXRofSIpKQogICAgdDAgPSBkYXRldGltZS5ub3coKQogICAg
#0#CiAgICAjIFNldHVwIGRpcmVjdG9yaWVzCiAgICB0ZW1wX2RpciA9IG91dHB1dF9yb290IC8gZiIu
#0#dGVtcF9wcmVwcm9jZXNzX3tkYXRhc2V0X25hbWV9IgogICAgaWYgdGVtcF9kaXIuZXhpc3RzKCk6
#0#CiAgICAgICAgc2h1dGlsLnJtdHJlZSh0ZW1wX2RpcikKICAgIHRlbXBfZGlyLm1rZGlyKHBhcmVu
#0#dHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKICAgIAogICAgIyBUYXJnZXQgZml4ZWQgZGF0YXNldCBk
#0#aXIKICAgIGRhdGFzZXRfb3V0cHV0X2RpciA9IG91dHB1dF9yb290IC8gImZpeGVkIiAvIGRhdGFz
#0#ZXRfbmFtZQogICAgaWYgZGF0YXNldF9vdXRwdXRfZGlyLmV4aXN0cygpOgogICAgICAgIGJyaWNr
#0#c19kaXIgPSBkYXRhc2V0X291dHB1dF9kaXIgLyAiYnJpY2tzIgogICAgICAgIGlmIGJyaWNrc19k
#0#aXIuZXhpc3RzKCk6CiAgICAgICAgICAgIHNodXRpbC5ybXRyZWUoYnJpY2tzX2RpcikKICAgIGRh
#0#dGFzZXRfb3V0cHV0X2Rpci5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCiAgICAK
#0#ICAgIHRyeToKICAgICAgICAjIFN0ZXAgMTogRXh0cmFjdGlvbiBvZiBtZXRhZGF0YQogICAgICAg
#0#IHRlbXBfbWV0YV9qc29uID0gdGVtcF9kaXIgLyAibWV0YS5qc29uIgogICAgICAgIHJ1bl9zdGVw
#0#KCIxLWltc19tZXRhZGF0YS5weSIsIHN0cihpbXNfcGF0aCksIHN0cih0ZW1wX21ldGFfanNvbikp
#0#CiAgICAgICAgCiAgICAgICAgIyBTdGVwIDI6IE5vcm1hbGl6YXRpb24sIEJhY2tncm91bmQgc3Vi
#0#dHJhY3Rpb24sIERvd25zY2FsaW5nCiAgICAgICAgcnVuX3N0ZXAoIjItaW1hZ2VfcHJvY2Vzc29y
#0#LnB5Iiwgc3RyKGltc19wYXRoKSwgc3RyKHRlbXBfbWV0YV9qc29uKSwgc3RyKHRlbXBfZGlyKSkK
#0#ICAgICAgICAKICAgICAgICAjIFN0ZXAgMzogQ29tcHV0ZSB0aHVtYm5haWwgTUlQCiAgICAgICAg
#0#d2l0aCBvcGVuKHRlbXBfZGlyIC8gInByb2Nlc3NpbmdfbWV0YS5qc29uIiwgInIiLCBlbmNvZGlu
#0#Zz0idXRmLTgiKSBhcyBmbToKICAgICAgICAgICAgcHJvY19tZXRhID0ganNvbi5sb2FkKGZtKQog
#0#ICAgICAgIGJ1aWxkX3RodW1ibmFpbCh0ZW1wX2RpciwgZGF0YXNldF9vdXRwdXRfZGlyLCBwcm9j
#0#X21ldGEpCiAgICAgICAgCiAgICAgICAgIyBTdGVwIDQ6IENodW5raW5nIDY0wrMgJiBQYWNrIGJ1
#0#aWxkaW5nCiAgICAgICAgcnVuX3N0ZXAoIjMtY2h1bmtfcGFja2VyLnB5Iiwgc3RyKHRlbXBfZGly
#0#KSwgc3RyKGRhdGFzZXRfb3V0cHV0X2RpcikpCiAgICAgICAgCiAgICAgICAgIyBTdGVwIDU6IENh
#0#dGFsb2cgbWV0YWRhdGEgKGRhdGFzZXQuanNvbiAvIG1ldGFkYXRhLmpzb24pCiAgICAgICAgcnVu
#0#X3N0ZXAoIjQtY2F0YWxvZ19nZW5lcmF0b3IucHkiLCBzdHIodGVtcF9kaXIpLCBzdHIoZGF0YXNl
#0#dF9vdXRwdXRfZGlyKSkKICAgICAgICAKICAgICAgICBlbGFwc2VkID0gKGRhdGV0aW1lLm5vdygp
#0#IC0gdDApLnRvdGFsX3NlY29uZHMoKQogICAgICAgIHByaW50KF9vayhmIiAgIFtPS10ge2RhdGFz
#0#ZXRfbmFtZX0gdGVybWluZSBlbiB7ZWxhcHNlZDouMGZ9cyIpKQogICAgZXhjZXB0IEV4Y2VwdGlv
#0#biBhcyBlOgogICAgICAgIHByaW50KF9lcnIoZiIgICBbWF0ge2RhdGFzZXRfbmFtZX0gOiB7ZX0i
#0#KSwgZmlsZT1zeXMuc3RkZXJyKQogICAgICAgIHRyYWNlYmFjay5wcmludF9leGMoKQogICAgZmlu
#0#YWxseToKICAgICAgICAjIENsZWFuIHVwIHRlbXBvcmFyeSBwcm9jZXNzaW5nIGJpbmFyeSBmaWxl
#0#cyB0byBmcmVlIHNwYWNlLgogICAgICAgICMgaWdub3JlX2Vycm9yczogb24gYSBDdHJsK0MgdGVh
#0#cmRvd24gYSBqdXN0LWtpbGxlZCB3b3JrZXIgbWF5IHN0aWxsIGhvbGQgYQogICAgICAgICMgaGFu
#0#ZGxlIGZvciBhIGZldyBtcyDigJQgbmV2ZXIgbGV0IGNsZWFudXAgbWFzayB0aGUgaW50ZXJydXB0
#0#aW9uLgogICAgICAgIGlmIHRlbXBfZGlyLmV4aXN0cygpOgogICAgICAgICAgICBzaHV0aWwucm10
#0#cmVlKHRlbXBfZGlyLCBpZ25vcmVfZXJyb3JzPVRydWUpCgpkZWYgbWFpbigpOgogICAgcGFyc2Vy
#0#ID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRpb249IklSSUJITSBNaWNyb3Njb3B5
#0#IFByZXByb2Nlc3NpbmcgVW5pZmllZCBQaXBlbGluZSIpCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50
#0#KCItLWlucHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iSW5wdXQgZGlyZWN0b3J5IGNvbnRhaW5p
#0#bmcgcmF3IC5pbXMgZmlsZXMuIikKICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0tb3V0cHV0Iiwg
#0#cmVxdWlyZWQ9VHJ1ZSwgaGVscD0iT3V0cHV0IERBVEFfV0VCIGRpcmVjdG9yeSBvZiB0aGUgd2Vi
#0#IHBsYXRmb3JtLiIpCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLW9ubHkiLCBkZWZhdWx0PU5v
#0#bmUsIGhlbHA9Ikdsb2IgcGF0dGVybiB0byBmaWx0ZXIgZmlsZXMgdG8gcHJvY2VzcyAoZS5nLiAn
#0#KkU4KicpLiIpCiAgICBhcmdzID0gcGFyc2VyLnBhcnNlX2FyZ3MoKQoKICAgIGlucHV0X2RpciA9
#0#IFBhdGgoYXJncy5pbnB1dCkKICAgIG91dHB1dF9kaXIgPSBQYXRoKGFyZ3Mub3V0cHV0KQoKICAg
#0#IGlmIG5vdCBpbnB1dF9kaXIuaXNfZGlyKCk6CiAgICAgICAgc3lzLmV4aXQoZiJbRkFUQUxdIElu
#0#cHV0IGRpcmVjdG9yeSBub3QgZm91bmQ6IHtpbnB1dF9kaXJ9IikKICAgICAgICAKICAgIG91dHB1
#0#dF9kaXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAgICMgR2xvYiBJTVMg
#0#ZmlsZXMKICAgIGltc19maWxlcyA9IHNvcnRlZChpbnB1dF9kaXIuZ2xvYigiKi5pbXMiKSkKICAg
#0#IGlmIGFyZ3Mub25seToKICAgICAgICBpbXNfZmlsZXMgPSBbcCBmb3IgcCBpbiBpbXNfZmlsZXMg
#0#aWYgZm5tYXRjaC5mbm1hdGNoKHAubmFtZSwgYXJncy5vbmx5KV0KCiAgICBpZiBub3QgaW1zX2Zp
#0#bGVzOgogICAgICAgIHByaW50KF93YXJuKGYiQXVjdW4gZmljaGllciAuaW1zIGNvcnJlc3BvbmRh
#0#bnQgZGFucyB7aW5wdXRfZGlyfSIpKQogICAgICAgIHN5cy5leGl0KDApCgogICAgcHJpbnQoKQog
#0#ICAgcHJpbnQoX2hkcigiICBQaXBlbGluZSBkZSBwcmVwcm9jZXNzaW5nICAiKSArIF9kaW0oZiJ2
#0#e19fdmVyc2lvbl9ffSIpKQogICAgcHJpbnQoX2RpbShmIiAgc291cmNlICAgICAgOiB7aW5wdXRf
#0#ZGlyfSIpKQogICAgcHJpbnQoX2RpbShmIiAgZGVzdGluYXRpb24gOiB7b3V0cHV0X2Rpcn0iKSkK
#0#ICAgIHByaW50KF9kaW0oZiIgIGRhdGFzZXRzICAgIDoge2xlbihpbXNfZmlsZXMpfSAgIChmaWx0
#0#cmU6IHthcmdzLm9ubHkgb3IgJyonfSkiKSkKCiAgICAjIEdyYWNlZnVsIEN0cmwrQzogY29uZmly
#0#bSB3aXRoIHRoZSB1c2VyLCB0aGVuIHRlYXIgdGhlIHJ1bm5pbmcgc3RlcCBkb3duIGNsZWFubHku
#0#CiAgICBfaW5zdGFsbF9zaWdpbnRfaGFuZGxlcigpCgogICAgIyBPbmUgZGF0YXNldCBhdCBhIHRp
#0#bWUgKGJvdW5kZWQgUkFNKSDigJQgZWFjaCBzdGVwIGFscmVhZHkgbXVsdGl0aHJlYWRzIGludGVy
#0#bmFsbHkuCiAgICBpbnRlcnJ1cHRlZCA9IEZhbHNlCiAgICBmb3IgaSwgaW1zX2ZpbGUgaW4gZW51
#0#bWVyYXRlKGltc19maWxlcyk6CiAgICAgICAgdHJ5OgogICAgICAgICAgICBwcm9jZXNzX2ltc19m
#0#aWxlKGltc19maWxlLCBvdXRwdXRfZGlyLCBpICsgMSwgbGVuKGltc19maWxlcykpCiAgICAgICAg
#0#ZXhjZXB0IEtleWJvYXJkSW50ZXJydXB0OgogICAgICAgICAgICBpbnRlcnJ1cHRlZCA9IFRydWUK
#0#ICAgICAgICAgICAgYnJlYWsKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAgICAg
#0#ICAgICAgcHJpbnQoX2VycihmIiAgIFtYXSB7aW1zX2ZpbGUubmFtZX0gOiB7ZXhjfSIpKQoKICAg
#0#IGlmIGludGVycnVwdGVkOgogICAgICAgICMgUmVtb3ZlIGFueSBoYWxmLXdyaXR0ZW4gdGVtcCBm
#0#b2xkZXIgbGVmdCBieSB0aGUgYWJvcnRlZCBkYXRhc2V0LgogICAgICAgIGZvciBzdHJheSBpbiBv
#0#dXRwdXRfZGlyLmdsb2IoIi50ZW1wX3ByZXByb2Nlc3NfKiIpOgogICAgICAgICAgICBzaHV0aWwu
#0#cm10cmVlKHN0cmF5LCBpZ25vcmVfZXJyb3JzPVRydWUpCiAgICAgICAgcHJpbnQoKQogICAgICAg
#0#IHByaW50KF93YXJuKCIgIFBpcGVsaW5lIGludGVycm9tcHUgcGFyIGwndXRpbGlzYXRldXIgKEN0
#0#cmwrQykuIEV0YXQgbmV0dG95ZS4iKSkKICAgICAgICBzeXMuZXhpdCgxMzApCgogICAgcHJpbnQo
#0#KQogICAgcHJpbnQoX29rKCIgIFBpcGVsaW5lIHRlcm1pbmUuIikpCgppZiBfX25hbWVfXyA9PSAi
#0#X19tYWluX18iOgogICAgdHJ5OgogICAgICAgIG1haW4oKQogICAgZXhjZXB0IEtleWJvYXJkSW50
#0#ZXJydXB0OgogICAgICAgICMgQ3RybCtDIGNvbmZpcm1lZCBvdXRzaWRlIGEgZGF0YXNldCAoZS5n
#0#LiBiZXR3ZWVuIHN0ZXBzKSDigJQgZXhpdCBjbGVhbmx5LgogICAgICAgIHByaW50KF93YXJuKCJc
#0#blshXSBQaXBlbGluZSBhcnJldGUuIiksIGZpbGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMuZXhp
#0#dCgxMzApCg==
:: ---- [1] 1-ims_metadata.py (3620 octets) ----
#1#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgcmUKaW1wb3J0IHN5cwpm
#1#cm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKaW1wb3J0IGg1cHkKaW1wb3J0IG51bXB5IGFzIG5wCgpk
#1#ZWYgYXR0cl9zdHIoZ3JvdXAsIGtleSwgZGVmYXVsdD0iIik6CiAgICBpZiBncm91cCBpcyBOb25l
#1#OgogICAgICAgIHJldHVybiBkZWZhdWx0CiAgICB2ID0gZ3JvdXAuYXR0cnMuZ2V0KGtleSwgZGVm
#1#YXVsdCkKICAgIGlmIGlzaW5zdGFuY2UodiwgKGJ5dGVzLCBucC5ieXRlc18pKToKICAgICAgICBy
#1#ZXR1cm4gdi5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikuc3RyaXAoKQogICAgaWYg
#1#aXNpbnN0YW5jZSh2LCBucC5uZGFycmF5KToKICAgICAgICB0cnk6CiAgICAgICAgICAgIHJldHVy
#1#biBiIiIuam9pbihieXRlcyhjKSBpZiBpc2luc3RhbmNlKGMsIChieXRlcywgbnAuYnl0ZXNfKSkK
#1#ICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVsc2UgYy50b2J5dGVzKCkgZm9yIGMgaW4gdgog
#1#ICAgICAgICAgICAgICAgICAgICAgICAgICApLmRlY29kZSgidXRmLTgiLCBlcnJvcnM9InJlcGxh
#1#Y2UiKS5zdHJpcCgpCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAgICAgICAgICAgcmV0dXJu
#1#ICIiLmpvaW4oCiAgICAgICAgICAgICAgICAoYy5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBs
#1#YWNlIikgaWYgaXNpbnN0YW5jZShjLCAoYnl0ZXMsIG5wLmJ5dGVzXykpIGVsc2Ugc3RyKGMpKQog
#1#ICAgICAgICAgICAgICAgZm9yIGMgaW4gdgogICAgICAgICAgICApLnN0cmlwKCkKICAgIHJldHVy
#1#biBzdHIodikuc3RyaXAoKQoKZGVmIHJlYWRfaW1zX21ldGFkYXRhKGZpbGVfcGF0aDogUGF0aCkg
#1#LT4gZGljdDoKICAgIHdpdGggaDVweS5GaWxlKHN0cihmaWxlX3BhdGgpLCAiciIpIGFzIGY6CiAg
#1#ICAgICAgaW5mbyA9IGYuZ2V0KCJEYXRhU2V0SW5mbyIsIHt9KS5nZXQoIkltYWdlIiwgTm9uZSkK
#1#ICAgICAgICAKICAgICAgICB3aWR0aCA9IGludChhdHRyX3N0cihpbmZvLCAiWCIsICIxIikgb3Ig
#1#MSkKICAgICAgICBoZWlnaHQgPSBpbnQoYXR0cl9zdHIoaW5mbywgIlkiLCAiMSIpIG9yIDEpCiAg
#1#ICAgICAgZGVwdGggPSBpbnQoYXR0cl9zdHIoaW5mbywgIloiLCAiMSIpIG9yIDEpCgogICAgICAg
#1#IGRlZiBfZXh0KGtleSwgZmFsbGJhY2s9MC4wKToKICAgICAgICAgICAgdHJ5OgogICAgICAgICAg
#1#ICAgICAgcmV0dXJuIGZsb2F0KGF0dHJfc3RyKGluZm8sIGtleSwgc3RyKGZhbGxiYWNrKSkpCiAg
#1#ICAgICAgICAgIGV4Y2VwdCBWYWx1ZUVycm9yOgogICAgICAgICAgICAgICAgcmV0dXJuIGZhbGxi
#1#YWNrCgogICAgICAgIGV4dF9taW5feCA9IF9leHQoIkV4dE1pbjAiKQogICAgICAgIGV4dF9tYXhf
#1#eCA9IF9leHQoIkV4dE1heDAiLCAxLjApCiAgICAgICAgZXh0X21pbl95ID0gX2V4dCgiRXh0TWlu
#1#MSIpCiAgICAgICAgZXh0X21heF95ID0gX2V4dCgiRXh0TWF4MSIsIDEuMCkKICAgICAgICBleHRf
#1#bWluX3ogPSBfZXh0KCJFeHRNaW4yIikKICAgICAgICBleHRfbWF4X3ogPSBfZXh0KCJFeHRNYXgy
#1#IiwgMS4wKQoKICAgICAgICB2b3hfeCA9IChleHRfbWF4X3ggLSBleHRfbWluX3gpIC8gbWF4KHdp
#1#ZHRoLCAxKQogICAgICAgIHZveF95ID0gKGV4dF9tYXhfeSAtIGV4dF9taW5feSkgLyBtYXgoaGVp
#1#Z2h0LCAxKQogICAgICAgIHZveF96ID0gKGV4dF9tYXhfeiAtIGV4dF9taW5feikgLyBtYXgoZGVw
#1#dGgsIDEpCgogICAgICAgIHJlczAgPSBmLmdldCgiRGF0YVNldCIsIHt9KS5nZXQoIlJlc29sdXRp
#1#b25MZXZlbCAwIiwge30pCiAgICAgICAgdGltZXBvaW50cyA9IHNvcnRlZCgKICAgICAgICAgICAg
#1#W2sgZm9yIGsgaW4gcmVzMC5rZXlzKCkgaWYgay5zdGFydHN3aXRoKCJUaW1lUG9pbnQiKV0sCiAg
#1#ICAgICAgICAgIGtleT1sYW1iZGEgeDogaW50KHguc3BsaXQoKVstMV0pCiAgICAgICAgKQogICAg
#1#ICAgIG5fdHAgPSBsZW4odGltZXBvaW50cykgb3IgMQoKICAgICAgICBjaGFubmVscyA9IFtdCiAg
#1#ICAgICAgaWYgdGltZXBvaW50czoKICAgICAgICAgICAgdHAwID0gcmVzMFt0aW1lcG9pbnRzWzBd
#1#XQogICAgICAgICAgICBjaGFubmVscyA9IHNvcnRlZCgKICAgICAgICAgICAgICAgIFtrIGZvciBr
#1#IGluIHRwMC5rZXlzKCkgaWYgay5zdGFydHN3aXRoKCJDaGFubmVsIildLAogICAgICAgICAgICAg
#1#ICAga2V5PWxhbWJkYSB4OiBpbnQoeC5zcGxpdCgpWy0xXSkKICAgICAgICAgICAgKQogICAgICAg
#1#IG5fY2ggPSBsZW4oY2hhbm5lbHMpIG9yIDEKCiAgICAgICAgY2hhbm5lbF9uYW1lcyA9IFtdCiAg
#1#ICAgICAgZm9yIGkgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAgIGNoX2luZm8gPSBmLmdldCgi
#1#RGF0YVNldEluZm8iLCB7fSkuZ2V0KGYiQ2hhbm5lbCB7aX0iLCBOb25lKQogICAgICAgICAgICBu
#1#YW1lX3JhdyA9IGF0dHJfc3RyKGNoX2luZm8sICJOYW1lIiwgIiIpIGlmIGNoX2luZm8gZWxzZSAi
#1#IgogICAgICAgICAgICBuYW1lID0gcmUuc3ViKHInXHgwMC4qJywgJycsIG5hbWVfcmF3KS5zdHJp
#1#cCgpCiAgICAgICAgICAgIGlmIG5vdCBuYW1lIG9yIHJlLm1hdGNoKHIiXmNoKGFubmVsKT9ccypc
#1#ZCskIiwgbmFtZSwgcmUuSUdOT1JFQ0FTRSk6CiAgICAgICAgICAgICAgICBuYW1lID0gZiJDaGFu
#1#bmVsIHtpKzF9IgogICAgICAgICAgICBjaGFubmVsX25hbWVzLmFwcGVuZChuYW1lKQoKICAgICAg
#1#ICByZXR1cm4gewogICAgICAgICAgICAid2lkdGgiOiB3aWR0aCwKICAgICAgICAgICAgImhlaWdo
#1#dCI6IGhlaWdodCwKICAgICAgICAgICAgImRlcHRoIjogZGVwdGgsCiAgICAgICAgICAgICJuX2No
#1#YW5uZWxzIjogbl9jaCwKICAgICAgICAgICAgIm5fdGltZXBvaW50cyI6IG5fdHAsCiAgICAgICAg
#1#ICAgICJ2b3hlbF9zaXplIjogewogICAgICAgICAgICAgICAgIngiOiByb3VuZCh2b3hfeCwgNiks
#1#CiAgICAgICAgICAgICAgICAieSI6IHJvdW5kKHZveF95LCA2KSwKICAgICAgICAgICAgICAgICJ6
#1#Ijogcm91bmQodm94X3osIDYpCiAgICAgICAgICAgIH0sCiAgICAgICAgICAgICJjaGFubmVsX25h
#1#bWVzIjogY2hhbm5lbF9uYW1lcwogICAgICAgIH0KCmlmIF9fbmFtZV9fID09ICJfX21haW5fXyI6
#1#CiAgICBpZiBsZW4oc3lzLmFyZ3YpIDwgMzoKICAgICAgICBwcmludCgiVXNhZ2U6IHB5dGhvbiAx
#1#LWltc19tZXRhZGF0YS5weSA8aW5wdXRfaW1zPiA8b3V0cHV0X2pzb24+IikKICAgICAgICBzeXMu
#1#ZXhpdCgxKQogICAgCiAgICBpbnB1dF9wYXRoID0gUGF0aChzeXMuYXJndlsxXSkKICAgIG91dHB1
#1#dF9wYXRoID0gUGF0aChzeXMuYXJndlsyXSkKICAgIAogICAgdHJ5OgogICAgICAgIG1ldGEgPSBy
#1#ZWFkX2ltc19tZXRhZGF0YShpbnB1dF9wYXRoKQogICAgICAgIHdpdGggb3BlbihvdXRwdXRfcGF0
#1#aCwgInciLCBlbmNvZGluZz0idXRmLTgiKSBhcyBmOgogICAgICAgICAgICBqc29uLmR1bXAobWV0
#1#YSwgZiwgaW5kZW50PTIpCiAgICAgICAgcHJpbnQoZiJbTUVUQURBVEFdIEV4dHJhY3RlZCBtZXRh
#1#ZGF0YSB0byB7b3V0cHV0X3BhdGh9IikKICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgICAg
#1#ICBwcmludChmIltFUlJPUl0gRmFpbGVkIHRvIHJlYWQgbWV0YWRhdGE6IHtlfSIsIGZpbGU9c3lz
#1#LnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQo=
:: ---- [2] 2-image_processor.py (9839 octets) ----
#2#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgc3lzCmZyb20gcGF0aGxp
#2#YiBpbXBvcnQgUGF0aAppbXBvcnQgaDVweQppbXBvcnQgbnVtcHkgYXMgbnAKZnJvbSBQSUwgaW1w
#2#b3J0IEltYWdlCmZyb20gc2NpcHkubmRpbWFnZSBpbXBvcnQgbWVkaWFuX2ZpbHRlciwgYmluYXJ5
#2#X29wZW5pbmcsIGJpbmFyeV9kaWxhdGlvbgpmcm9tIGNvbmN1cnJlbnQuZnV0dXJlcyBpbXBvcnQg
#2#UHJvY2Vzc1Bvb2xFeGVjdXRvcgppbXBvcnQgb3MKZnJvbSB0cWRtIGltcG9ydCB0cWRtCgpfX3Zl
#2#cnNpb25fXyA9ICIwLjEzLjAiCgpkZWYgcHJvY2Vzc196X2Jsb2NrKGFyZ3MpOgogICAgIiIiU2Vs
#2#ZWN0aXZlIE1hc2tlZCBNZWRpYW4gRmlsdGVyaW5nICsgV2luZG93IExldmVsaW5nIGZvciBvbmUg
#2#Wi1ibG9jay4KCiAgICBJbnNpZGUgdGhlIHNpZ25hbCBtYXNrIHRoZSBvcmlnaW5hbCAoc2hhcnAp
#2#IGJpb2xvZ2ljYWwgc2lnbmFsIGlzIGtlcHQgYXMtaXM7CiAgICBvdXRzaWRlIHRoZSBtYXNrIHRo
#2#ZSBiYWNrZ3JvdW5kIGlzIHJlcGxhY2VkIGJ5IGEgM0QgbWVkaWFuIChzaXplPTMpIHRoYXQKICAg
#2#IGNydXNoZXMgc2hvdC1ub2lzZSBhbmQgaXNvbGF0ZWQgaG90IHBpeGVscyB3aXRob3V0IGJsdXJy
#2#aW5nIHRoZSBjZWxscy4gVGhlCiAgICBibG9jayBjYXJyaWVzIGEgwrExIFogaGFsbyBzbyB0aGUg
#2#bWVkaWFuIHNlZXMgcmVhbCBuZWlnaGJvdXJzIGFjcm9zcyBibG9jawogICAgc2VhbXM7IHRoZSBo
#2#YWxvIGlzIHN0cmlwcGVkIGJlZm9yZSByZXR1cm4uIEZpbmFsbHkgYSBXaW5kb3cgTGV2ZWxpbmcg
#2#bWFwcwogICAgW2JnX2Zsb29yLCBzaWdfbWF4XSAtPiBbMCwgMjU1XSAodWludDgpIOKAlCBhbnkg
#2#dmFsdWUgPD0gYmdfZmxvb3IgY29sbGFwc2VzIHRvCiAgICBhbiBhYnNvbHV0ZSAwLCBndWFyYW50
#2#ZWVpbmcgcHVyZS1ibGFjayBlbXB0eSBzcGFjZSBmb3IgdGhlIFNWUiBicmljayBwYWNrZXIuCiAg
#2#ICAiIiIKICAgIHpfc3RhcnQsIGhhbG9fbG8sIGhhbG9faGksIGJsb2NrX2RhdGEsIGJsb2NrX21h
#2#c2ssIGJnX2Zsb29yLCBzaWdfbWF4ID0gYXJncwoKICAgIGlmIHNpZ19tYXggLSBiZ19mbG9vciA8
#2#PSAwLjA6CiAgICAgICAgc2lnX21heCA9IGJnX2Zsb29yICsgMS4wCgogICAgIyBNYXNrZWQgY29t
#2#cG9zaXRpbmc6IGtlZXAgc2lnbmFsIGluc2lkZSB0aGUgbWFzaywgc21vb3RoIHRoZSByZXN0CiAg
#2#ICBzbW9vdGhlZCA9IG1lZGlhbl9maWx0ZXIoYmxvY2tfZGF0YSwgc2l6ZT0zKQogICAgY29tcG9z
#2#aXRlID0gbnAud2hlcmUoYmxvY2tfbWFzaywgYmxvY2tfZGF0YSwgc21vb3RoZWQpCgogICAgIyBX
#2#aW5kb3cgTGV2ZWxpbmcgW2JnX2Zsb29yLCBzaWdfbWF4XSAtPiBbMCwgMjU1XQogICAgY2xlYW4g
#2#PSBucC5jbGlwKGNvbXBvc2l0ZSwgYmdfZmxvb3IsIHNpZ19tYXgpCiAgICBub3JtID0gKGNsZWFu
#2#IC0gYmdfZmxvb3IpIC8gKHNpZ19tYXggLSBiZ19mbG9vcikKICAgIGJsb2NrX3U4ID0gKG5vcm0g
#2#KiAyNTUuMCkuYXN0eXBlKG5wLnVpbnQ4KQoKICAgICMgU3RyaXAgdGhlIFogaGFsbyBiZWZvcmUg
#2#cmVhc3NlbWJseQogICAgel9oaSA9IGJsb2NrX3U4LnNoYXBlWzBdIC0gaGFsb19oaQogICAgcmV0
#2#dXJuIHpfc3RhcnQsIGJsb2NrX3U4W2hhbG9fbG86el9oaV0KCmRlZiBwcm9jZXNzX2ltYWdlKGlu
#2#cHV0X2ltczogUGF0aCwgbWV0YWRhdGFfanNvbjogUGF0aCwgdGVtcF9kaXI6IFBhdGgpOgogICAg
#2#d2l0aCBvcGVuKG1ldGFkYXRhX2pzb24sICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZjoKICAg
#2#ICAgICBtZXRhID0ganNvbi5sb2FkKGYpCiAgICAgICAgCiAgICBXLCBILCBEID0gbWV0YVsid2lk
#2#dGgiXSwgbWV0YVsiaGVpZ2h0Il0sIG1ldGFbImRlcHRoIl0KICAgIG5fY2ggPSBtZXRhWyJuX2No
#2#YW5uZWxzIl0KICAgIG5fdHAgPSBtZXRhWyJuX3RpbWVwb2ludHMiXQogICAgCiAgICB0ZW1wX2Rp
#2#ci5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCiAgICAKICAgICMgT3BlbiBJTVMg
#2#ZmlsZQogICAgZl9pbXMgPSBoNXB5LkZpbGUoc3RyKGlucHV0X2ltcyksICJyIikKICAgIHJlczAg
#2#PSBmX2ltc1siRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2ZWwgMCJdCiAgICB0cF9rZXlzID0gc29y
#2#dGVkKFtrIGZvciBrIGluIHJlczAua2V5cygpIGlmIGsuc3RhcnRzd2l0aCgiVGltZVBvaW50Iild
#2#LCBrZXk9bGFtYmRhIHg6IGludCh4LnNwbGl0KClbLTFdKSkKICAgIAogICAgIyBXZSB3aWxsIHNh
#2#dmUgZG93bnNjYWxlZCBzaGFwZXMgaW4gcHJvY2Vzc2luZ19tZXRhLmpzb24KICAgIGxvZF9pbmZv
#2#ID0gW10KICAgIAogICAgIyBEZXRlcm1pbmUgZG93bnNjYWxpbmcgTE9EIGxldmVscwogICAgbG9k
#2#ID0gMAogICAgbG9kX2luZm8uYXBwZW5kKHsKICAgICAgICAibG9kIjogbG9kLAogICAgICAgICJ3
#2#aWR0aCI6IFcsCiAgICAgICAgImhlaWdodCI6IEgsCiAgICAgICAgImRlcHRoIjogRAogICAgfSkK
#2#ICAgIAogICAgbWF4X2RpbSA9IG1heChXLCBIKQogICAgdGFyZ2V0X2RpbXMgPSBbXQogICAgY3Vy
#2#cl9kaW0gPSAyNTYKICAgIHdoaWxlIGN1cnJfZGltIDwgbWF4X2RpbToKICAgICAgICB0YXJnZXRf
#2#ZGltcy5hcHBlbmQoY3Vycl9kaW0pCiAgICAgICAgY3Vycl9kaW0gKj0gMgogICAgICAgIAogICAg
#2#dGFyZ2V0X2RpbXMucmV2ZXJzZSgpCiAgICAKICAgIGZvciB0YXJnZXRfZGltIGluIHRhcmdldF9k
#2#aW1zOgogICAgICAgIGxvZCArPSAxCiAgICAgICAgbG9kX2luZm8uYXBwZW5kKHsKICAgICAgICAg
#2#ICAgImxvZCI6IGxvZCwKICAgICAgICAgICAgIndpZHRoIjogdGFyZ2V0X2RpbSwKICAgICAgICAg
#2#ICAgImhlaWdodCI6IHRhcmdldF9kaW0sCiAgICAgICAgICAgICJkZXB0aCI6IEQKICAgICAgICB9
#2#KQogICAgICAgIAogICAgcHJpbnQoZiJbUFJPQ0VTU10gTE9EIGxldmVscyB0byBnZW5lcmF0ZTog
#2#e2xlbihsb2RfaW5mbyl9IikKICAgIGZvciBsaSBpbiBsb2RfaW5mbzoKICAgICAgICBwcmludChm
#2#IiAgTE9EIHtsaVsnbG9kJ119OiB7bGlbJ3dpZHRoJ119eHtsaVsnaGVpZ2h0J119eHtsaVsnZGVw
#2#dGgnXX0iKQoKICAgIGZvciB0X2lkeCwgdHBfa2V5IGluIGVudW1lcmF0ZSh0cF9rZXlzKToKICAg
#2#ICAgICBjaF9rZXlzID0gc29ydGVkKFtrIGZvciBrIGluIHJlczBbdHBfa2V5XS5rZXlzKCkgaWYg
#2#ay5zdGFydHN3aXRoKCJDaGFubmVsIildLCBrZXk9bGFtYmRhIHg6IGludCh4LnNwbGl0KClbLTFd
#2#KSkKICAgICAgICAKICAgICAgICBmb3IgY19pZHgsIGNoX2tleSBpbiBlbnVtZXJhdGUoY2hfa2V5
#2#cyk6CiAgICAgICAgICAgIHByaW50KGYiW1BST0NFU1NdIFByb2Nlc3NpbmcgQ2hhbm5lbCB7Y19p
#2#ZHh9IChUIHt0X2lkeH0pLi4uIiwgZmx1c2g9VHJ1ZSkKICAgICAgICAgICAgZHMgPSByZXMwW3Rw
#2#X2tleV1bY2hfa2V5XVsiRGF0YSJdCiAgICAgICAgICAgIAogICAgICAgICAgICBwcmludChmIiAg
#2#TG9hZGluZyAzRCB2b2x1bWUgKHtXfXh7SH14e0R9KSBpbiBtZW1vcnkgYXMgRmxvYXQzMi4uLiIs
#2#IGZsdXNoPVRydWUpCiAgICAgICAgICAgICMgUmVhZCBlbnRpcmUgdm9sdW1lIGRpcmVjdGx5IHRv
#2#IGFsbG93IGg1cHkgQy1jb3JlIHRvIG9wdGltaXplIGNodW5rIHJlYWRzCiAgICAgICAgICAgICMg
#2#RXh0cmVtZWx5IGZhc3QgY29tcGFyZWQgdG8gcmVhZGluZyBzbGljZS1ieS1zbGljZSBpbiBQeXRo
#2#b24KICAgICAgICAgICAgdm9sID0gZHNbOkQsIDpILCA6V10uYXN0eXBlKG5wLmZsb2F0MzIpCgog
#2#ICAgICAgICAgICAjIOKUgOKUgOKUgCBTdGVwIDEgOiBCb3VuZCBlc3RpbWF0aW9uIChDb3JuZXIg
#2#U2FtcGxpbmcpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#2#gOKUgOKUgAogICAgICAgICAgICAjIGJnX2Zsb29yID0gOTl0aCBwZXJjZW50aWxlIG9mIHRoZSA4
#2#IHZvbHVtZSBjb3JuZXJzIChwdXJlIGNhbWVyYQogICAgICAgICAgICAjIGJhY2tncm91bmQsIG5v
#2#IGVtYnJ5byB0aGVyZSk7IHNpZ19tYXggPSA5OS45dGggcGVyY2VudGlsZSBvZiB0aGUKICAgICAg
#2#ICAgICAgIyBnbG9iYWxseSBzdWItc2FtcGxlZCB2b2x1bWUgKHNhdHVyYXRlIHRoZSBicmlnaHRl
#2#c3QgMC4xICUpLgogICAgICAgICAgICBwcmludCgiICBTdGVwIDE6IEVzdGltYXRpb24gZGVzIGJv
#2#cm5lcyAoQ29ybmVyIFNhbXBsaW5nKS4uLiIsIGZsdXNoPVRydWUpCiAgICAgICAgICAgIGNvcm5l
#2#cl9zaXplID0gbWF4KDEsIG1pbigzMiwgVyAvLyA0LCBIIC8vIDQsIEQgLy8gNCkpCiAgICAgICAg
#2#ICAgIGNvcm5lcnMgPSBbCiAgICAgICAgICAgICAgICB2b2xbOmNvcm5lcl9zaXplLCA6Y29ybmVy
#2#X3NpemUsIDpjb3JuZXJfc2l6ZV0sCiAgICAgICAgICAgICAgICB2b2xbOmNvcm5lcl9zaXplLCA6
#2#Y29ybmVyX3NpemUsIC1jb3JuZXJfc2l6ZTpdLAogICAgICAgICAgICAgICAgdm9sWzpjb3JuZXJf
#2#c2l6ZSwgLWNvcm5lcl9zaXplOiwgOmNvcm5lcl9zaXplXSwKICAgICAgICAgICAgICAgIHZvbFs6
#2#Y29ybmVyX3NpemUsIC1jb3JuZXJfc2l6ZTosIC1jb3JuZXJfc2l6ZTpdLAogICAgICAgICAgICAg
#2#ICAgdm9sWy1jb3JuZXJfc2l6ZTosIDpjb3JuZXJfc2l6ZSwgOmNvcm5lcl9zaXplXSwKICAgICAg
#2#ICAgICAgICAgIHZvbFstY29ybmVyX3NpemU6LCA6Y29ybmVyX3NpemUsIC1jb3JuZXJfc2l6ZTpd
#2#LAogICAgICAgICAgICAgICAgdm9sWy1jb3JuZXJfc2l6ZTosIC1jb3JuZXJfc2l6ZTosIDpjb3Ju
#2#ZXJfc2l6ZV0sCiAgICAgICAgICAgICAgICB2b2xbLWNvcm5lcl9zaXplOiwgLWNvcm5lcl9zaXpl
#2#OiwgLWNvcm5lcl9zaXplOl0KICAgICAgICAgICAgXQogICAgICAgICAgICBjb3JuZXJfZGF0YSA9
#2#IG5wLmNvbmNhdGVuYXRlKFtjLmZsYXR0ZW4oKSBmb3IgYyBpbiBjb3JuZXJzXSkKICAgICAgICAg
#2#ICAgYmdfZmxvb3IgPSBmbG9hdChucC5wZXJjZW50aWxlKGNvcm5lcl9kYXRhLCA5OS4wKSkKICAg
#2#ICAgICAgICAgcHJpbnQoZiIgICAgYmdfZmxvb3IgKDk5ZSBjZW50aWxlIGR1IGJydWl0IGRlcyBj
#2#b2lucyk6IHtiZ19mbG9vcjouMmZ9IiwgZmx1c2g9VHJ1ZSkKCiAgICAgICAgICAgICMgU3ViLXNh
#2#bXBsZWQgZ2xvYmFsIHZvbHVtZSBmb3IgYSBmYXN0LCBSQU0tY2hlYXAgd2hpdGUtcG9pbnQgZXN0
#2#aW1hdGUKICAgICAgICAgICAgZG93bl92b2wgPSB2b2xbOjo0LCA6OjQsIDo6NF0KICAgICAgICAg
#2#ICAgc2lnX21heCA9IGZsb2F0KG5wLnBlcmNlbnRpbGUoZG93bl92b2wsIDk5LjkpKQogICAgICAg
#2#ICAgICBkZWwgZG93bl92b2wKICAgICAgICAgICAgcHJpbnQoZiIgICAgc2lnX21heCAoOTkuOWUg
#2#Y2VudGlsZSBnbG9iYWwpOiB7c2lnX21heDouMmZ9IiwgZmx1c2g9VHJ1ZSkKCiAgICAgICAgICAg
#2#ICMg4pSA4pSA4pSAIFN0ZXAgMiA6IFNpZ25hbCBtYXNrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#2#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#2#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgICAgICAgICAj
#2#IFRocmVzaG9sZCAxMCAlIGFib3ZlIHRoZSBub2lzZSBmbG9vcjsgYSBtb3JwaG9sb2dpY2FsIG9w
#2#ZW5pbmcgZHJvcHMKICAgICAgICAgICAgIyBpc29sYXRlZCBob3QgcGl4ZWxzIChzbyB0aGV5IGdl
#2#dCBtZWRpYW4tY3J1c2hlZCBiZWxvdyksIHRoZW4gYQogICAgICAgICAgICAjIDMtaXRlcmF0aW9u
#2#IGRpbGF0aW9uIGd1YXJkcyB0aGUgbmF0dXJhbCBmbHVvcmVzY2VudCBmYWRlLW91dCBhcm91bmQK
#2#ICAgICAgICAgICAgIyB0aGUgYmlvbG9naWNhbCBzaWduYWwgc28gdGhlIG1lZGlhbiBmaWx0ZXIg
#2#bmV2ZXIgYml0ZXMgaW50byBjZWxscy4KICAgICAgICAgICAgcHJpbnQoIiAgU3RlcCAyOiBDb25z
#2#dHJ1Y3Rpb24gZHUgbWFzcXVlIGRlIHNpZ25hbC4uLiIsIGZsdXNoPVRydWUpCiAgICAgICAgICAg
#2#IG1hc2sgPSB2b2wgPiAoYmdfZmxvb3IgKiAxLjEpCiAgICAgICAgICAgIG1hc2sgPSBiaW5hcnlf
#2#b3BlbmluZyhtYXNrLCBpdGVyYXRpb25zPTEpCiAgICAgICAgICAgIG1hc2sgPSBiaW5hcnlfZGls
#2#YXRpb24obWFzaywgaXRlcmF0aW9ucz0zKQogICAgICAgICAgICBwcmludChmIiAgICBDb3V2ZXJ0
#2#dXJlIGR1IG1hc3F1ZTogezEwMC4wICogbWFzay5tZWFuKCk6LjJmfSUgZGVzIHZveGVscyIsIGZs
#2#dXNoPVRydWUpCgogICAgICAgICAgICAjIOKUgOKUgOKUgCBTdGVwIDMgOiBNYXNrZWQgbWVkaWFu
#2#IGZpbHRlcmluZyArIFdpbmRvdyBMZXZlbGluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIAKICAgICAgICAgICAgIyBQYXJhbGxlbCBvdmVyIFotYmxvY2tzOyBlYWNoIGJsb2NrIGNh
#2#cnJpZXMgYSDCsTEgWiBoYWxvIGZvciB0aGUKICAgICAgICAgICAgIyAzRCBtZWRpYW4gc28gdGhl
#2#cmUgaXMgbm8gc2VhbSBiZXR3ZWVuIGJsb2Nrcy4KICAgICAgICAgICAgcHJpbnQoIiAgU3RlcCAz
#2#OiBNYXNrZWQgTWVkaWFuIEZpbHRlcmluZyArIFdpbmRvdyBMZXZlbGluZy4uLiIsIGZsdXNoPVRy
#2#dWUpCiAgICAgICAgICAgIHZvbF91OCA9IG5wLnplcm9zKChELCBILCBXKSwgZHR5cGU9bnAudWlu
#2#dDgpCiAgICAgICAgICAgIHpfY2h1bmtfc2l6ZSA9IG1heCg0LCBEIC8vIChvcy5jcHVfY291bnQo
#2#KSAqIDIpKQogICAgICAgICAgICB0YXNrcyA9IFtdCiAgICAgICAgICAgIGZvciB6X3N0YXJ0IGlu
#2#IHJhbmdlKDAsIEQsIHpfY2h1bmtfc2l6ZSk6CiAgICAgICAgICAgICAgICB6X2VuZCA9IG1pbih6
#2#X3N0YXJ0ICsgel9jaHVua19zaXplLCBEKQogICAgICAgICAgICAgICAgaGFsb19sbyA9IDEgaWYg
#2#el9zdGFydCA+IDAgZWxzZSAwCiAgICAgICAgICAgICAgICBoYWxvX2hpID0gMSBpZiB6X2VuZCA8
#2#IEQgZWxzZSAwCiAgICAgICAgICAgICAgICB6cywgemUgPSB6X3N0YXJ0IC0gaGFsb19sbywgel9l
#2#bmQgKyBoYWxvX2hpCiAgICAgICAgICAgICAgICBibG9ja19kYXRhID0gbnAuY29weSh2b2xbenM6
#2#emVdKQogICAgICAgICAgICAgICAgYmxvY2tfbWFzayA9IG5wLmNvcHkobWFza1t6czp6ZV0pCiAg
#2#ICAgICAgICAgICAgICB0YXNrcy5hcHBlbmQoKHpfc3RhcnQsIGhhbG9fbG8sIGhhbG9faGksIGJs
#2#b2NrX2RhdGEsIGJsb2NrX21hc2ssIGJnX2Zsb29yLCBzaWdfbWF4KSkKCiAgICAgICAgICAgIHdp
#2#dGggUHJvY2Vzc1Bvb2xFeGVjdXRvcihtYXhfd29ya2Vycz1vcy5jcHVfY291bnQoKSkgYXMgZXhl
#2#Y3V0b3I6CiAgICAgICAgICAgICAgICBmb3IgcmVzdWx0IGluIHRxZG0oZXhlY3V0b3IubWFwKHBy
#2#b2Nlc3Nfel9ibG9jaywgdGFza3MpLCB0b3RhbD1sZW4odGFza3MpLCBkZXNjPSJNYXNrZWQgTWVk
#2#aWFuICsgTGV2ZWxpbmciLCBsZWF2ZT1GYWxzZSwgYXNjaWk9VHJ1ZSwgbWluaW50ZXJ2YWw9Mi4w
#2#KToKICAgICAgICAgICAgICAgICAgICB6X3N0YXJ0X3JlcywgYmxvY2tfdTggPSByZXN1bHQKICAg
#2#ICAgICAgICAgICAgICAgICB6X2VuZF9yZXMgPSB6X3N0YXJ0X3JlcyArIGJsb2NrX3U4LnNoYXBl
#2#WzBdCiAgICAgICAgICAgICAgICAgICAgdm9sX3U4W3pfc3RhcnRfcmVzOnpfZW5kX3Jlc10gPSBi
#2#bG9ja191OAoKICAgICAgICAgICAgZGVsIHZvbCwgbWFzawoKICAgICAgICAgICAgIyDilIDilIDi
#2#lIAgU3RlcCA0IDogRXhwb3J0aW5nIGRvd25zY2FsZWQgTE9EIGxldmVscyDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgICAg
#2#ICAgICAgcHJpbnQoIiAgU3RlcCA0OiBFeHBvcnRpbmcgZG93bnNjYWxlZCBMT0QgbGV2ZWxzLi4u
#2#IiwgZmx1c2g9VHJ1ZSkKICAgICAgICAgICAgbG9kX2ZpbGVzID0ge30KICAgICAgICAgICAgZm9y
#2#IGxpIGluIGxvZF9pbmZvOgogICAgICAgICAgICAgICAgbG9kX251bSA9IGxpWyJsb2QiXQogICAg
#2#ICAgICAgICAgICAgbG9kX2ZpbGUgPSB0ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y19pZHh9
#2#X2xvZHtsb2RfbnVtfS5iaW4iCiAgICAgICAgICAgICAgICBsb2RfZmlsZXNbbG9kX251bV0gPSBv
#2#cGVuKGxvZF9maWxlLCAid2IiKQoKICAgICAgICAgICAgZm9yIHogaW4gdHFkbShyYW5nZShEKSwg
#2#ZGVzYz0iRXhwb3J0aW5nIExPRHMiLCBsZWF2ZT1GYWxzZSwgYXNjaWk9VHJ1ZSwgbWluaW50ZXJ2
#2#YWw9Mi4wKToKICAgICAgICAgICAgICAgIHNsaWNlX3U4ID0gdm9sX3U4W3pdCiAgICAgICAgICAg
#2#ICAgICAjIFdyaXRlIG5hdGl2ZSBMT0QwCiAgICAgICAgICAgICAgICBsb2RfZmlsZXNbMF0ud3Jp
#2#dGUoc2xpY2VfdTgudG9ieXRlcygpKQogICAgICAgICAgICAgICAgIyBXcml0ZSBkb3duc2NhbGVk
#2#IExPRHMKICAgICAgICAgICAgICAgIHBpbF9pbWcgPSBJbWFnZS5mcm9tYXJyYXkoc2xpY2VfdTgs
#2#IG1vZGU9IkwiKQogICAgICAgICAgICAgICAgZm9yIGxpIGluIGxvZF9pbmZvWzE6XToKICAgICAg
#2#ICAgICAgICAgICAgICBsb2RfbnVtID0gbGlbImxvZCJdCiAgICAgICAgICAgICAgICAgICAgcmVz
#2#aXplZCA9IHBpbF9pbWcucmVzaXplKChsaVsid2lkdGgiXSwgbGlbImhlaWdodCJdKSwgSW1hZ2Uu
#2#UmVzYW1wbGluZy5CSUxJTkVBUikKICAgICAgICAgICAgICAgICAgICByZXNpemVkX2FyciA9IG5w
#2#LmFzYXJyYXkocmVzaXplZCwgZHR5cGU9bnAudWludDgpCiAgICAgICAgICAgICAgICAgICAgbG9k
#2#X2ZpbGVzW2xvZF9udW1dLndyaXRlKHJlc2l6ZWRfYXJyLnRvYnl0ZXMoKSkKCiAgICAgICAgICAg
#2#ICMgQ2xvc2UgYWxsIGZpbGUgaGFuZGxlcwogICAgICAgICAgICBmb3IgZl9oYW5kbGUgaW4gbG9k
#2#X2ZpbGVzLnZhbHVlcygpOgogICAgICAgICAgICAgICAgZl9oYW5kbGUuY2xvc2UoKQogICAgICAg
#2#ICAgICBkZWwgdm9sX3U4CiAgICAgICAgICAgIHByaW50KGYiICBDaGFubmVsIHtjX2lkeH0gcHJv
#2#Y2Vzc2VkIHN1Y2Nlc3NmdWxseS4iKQoKICAgIGZfaW1zLmNsb3NlKCkKICAgIAogICAgIyBTYXZl
#2#IHRoZSBMT0QgaW5mbyBmb3IgbmV4dCBzdGVwCiAgICB3aXRoIG9wZW4odGVtcF9kaXIgLyAicHJv
#2#Y2Vzc2luZ19tZXRhLmpzb24iLCAidyIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAg
#2#IGpzb24uZHVtcCh7CiAgICAgICAgICAgICJsb2RfbGV2ZWxzIjogbG9kX2luZm8sCiAgICAgICAg
#2#ICAgICJ2b3hlbF9zaXplIjogbWV0YVsidm94ZWxfc2l6ZSJdLAogICAgICAgICAgICAiY2hhbm5l
#2#bF9uYW1lcyI6IG1ldGFbImNoYW5uZWxfbmFtZXMiXSwKICAgICAgICAgICAgIndpZHRoIjogVywK
#2#ICAgICAgICAgICAgImhlaWdodCI6IEgsCiAgICAgICAgICAgICJkZXB0aCI6IEQsCiAgICAgICAg
#2#ICAgICJuX2NoYW5uZWxzIjogbl9jaCwKICAgICAgICAgICAgIm5fdGltZXBvaW50cyI6IG5fdHAK
#2#ICAgICAgICB9LCBmbSwgaW5kZW50PTIpCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAg
#2#aWYgbGVuKHN5cy5hcmd2KSA8IDQ6CiAgICAgICAgcHJpbnQoIlVzYWdlOiBweXRob24gMi1pbWFn
#2#ZV9wcm9jZXNzb3IucHkgPGlucHV0X2ltcz4gPG1ldGFkYXRhX2pzb24+IDx0ZW1wX2Rpcj4iKQog
#2#ICAgICAgIHN5cy5leGl0KDEpCiAgICAgICAgCiAgICBpbnB1dF9pbXMgPSBQYXRoKHN5cy5hcmd2
#2#WzFdKQogICAgbWV0YWRhdGFfanNvbiA9IFBhdGgoc3lzLmFyZ3ZbMl0pCiAgICB0ZW1wX2RpciA9
#2#IFBhdGgoc3lzLmFyZ3ZbM10pCiAgICAKICAgIHRyeToKICAgICAgICBwcm9jZXNzX2ltYWdlKGlu
#2#cHV0X2ltcywgbWV0YWRhdGFfanNvbiwgdGVtcF9kaXIpCiAgICAgICAgcHJpbnQoZiJbUFJPQ0VT
#2#U10gSW1hZ2UgcHJvY2Vzc2luZyBjb21wbGV0ZS4iKQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBl
#2#OgogICAgICAgIGltcG9ydCB0cmFjZWJhY2sKICAgICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkK
#2#ICAgICAgICBwcmludChmIltFUlJPUl0gSW1hZ2UgcHJvY2Vzc2luZyBmYWlsZWQ6IHtlfSIsIGZp
#2#bGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQo=
:: ---- [3] 3-chunk_packer.py (11590 octets) ----
#3#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgbWF0aAppbXBvcnQgc3lz
#3#CmltcG9ydCBnemlwCmltcG9ydCBoYXNobGliCmZyb20gcGF0aGxpYiBpbXBvcnQgUGF0aAppbXBv
#3#cnQgbnVtcHkgYXMgbnAKZnJvbSBQSUwgaW1wb3J0IEltYWdlCmltcG9ydCBpbwpmcm9tIGNvbmN1
#3#cnJlbnQuZnV0dXJlcyBpbXBvcnQgUHJvY2Vzc1Bvb2xFeGVjdXRvcgppbXBvcnQgb3MKCmRlZiBw
#3#cm9jZXNzX2NodW5rKGFyZ3MpOgogICAgY2h1bmtfZGF0YSwgY2hfbWV0YSwgQlJJQ0tfU0laRSA9
#3#IGFyZ3MKICAgIG5vbl96ZXJvID0gbnAuY291bnRfbm9uemVybyhjaHVua19kYXRhKQogICAgdmFs
#3#aWRfdm94ZWxzID0gbWF4KDEsIGNoX21ldGFbInZhbGlkVm94ZWxDb3VudCJdKQogICAgb2NjID0g
#3#ZmxvYXQobm9uX3plcm8pIC8gZmxvYXQodmFsaWRfdm94ZWxzKQogICAgCiAgICBpc19ub25fZW1w
#3#dHkgPSBvY2MgPiAwLjAwMDUKICAgIGlmIG5vdCBpc19ub25fZW1wdHk6CiAgICAgICAgcmV0dXJu
#3#IChjaF9tZXRhWyJpZHgiXSwgb2NjLCBGYWxzZSwgTm9uZSkKICAgICAgICAKICAgIHBhZGRlZCA9
#3#IG5wLnplcm9zKChCUklDS19TSVpFLCBCUklDS19TSVpFLCBCUklDS19TSVpFKSwgZHR5cGU9bnAu
#3#dWludDgpCiAgICBkLCBoLCB3ID0gY2h1bmtfZGF0YS5zaGFwZQogICAgcGFkZGVkWzpkLCA6aCwg
#3#OnddID0gY2h1bmtfZGF0YQogICAgCiAgICBtb3NhaWMgPSBucC56ZXJvcygoNTEyLCA1MTIpLCBk
#3#dHlwZT1ucC51aW50OCkKICAgIGZvciB6IGluIHJhbmdlKDY0KToKICAgICAgICByb3cgPSB6IC8v
#3#IDgKICAgICAgICBjb2wgPSB6ICUgOAogICAgICAgIG1vc2FpY1tyb3cqNjQ6KHJvdysxKSo2NCwg
#3#Y29sKjY0Oihjb2wrMSkqNjRdID0gcGFkZGVkW3pdCiAgICAgICAgCiAgICBpbWcgPSBJbWFnZS5m
#3#cm9tYXJyYXkobW9zYWljKQogICAgYnVmID0gaW8uQnl0ZXNJTygpCiAgICBpbWcuc2F2ZShidWYs
#3#IGZvcm1hdD0iV0VCUCIsIGxvc3NsZXNzPVRydWUpCiAgICByZXR1cm4gKGNoX21ldGFbImlkeCJd
#3#LCBvY2MsIFRydWUsIGJ1Zi5nZXR2YWx1ZSgpKQoKZGVmIGJ1aWxkX3BhY2tzKHRlbXBfZGlyOiBQ
#3#YXRoLCBvdXRwdXRfZGlyOiBQYXRoKToKICAgIHdpdGggb3Blbih0ZW1wX2RpciAvICJwcm9jZXNz
#3#aW5nX21ldGEuanNvbiIsICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06CiAgICAgICAgcHJv
#3#Y19tZXRhID0ganNvbi5sb2FkKGZtKQogICAgICAgIAogICAgbG9kX2xldmVscyA9IHByb2NfbWV0
#3#YVsibG9kX2xldmVscyJdCiAgICBuX2NoID0gcHJvY19tZXRhWyJuX2NoYW5uZWxzIl0KICAgIG5f
#3#dHAgPSBwcm9jX21ldGFbIm5fdGltZXBvaW50cyJdCiAgICB2b3hlbF9zaXplID0gcHJvY19tZXRh
#3#WyJ2b3hlbF9zaXplIl0KICAgIGNoYW5uZWxfbmFtZXMgPSBwcm9jX21ldGFbImNoYW5uZWxfbmFt
#3#ZXMiXQogICAgCiAgICBicmlja3NfZGlyID0gb3V0cHV0X2RpciAvICJicmlja3MiCiAgICBicmlj
#3#a3NfZGlyLm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKICAgIAogICAgIyBHcmlk
#3#IGNvbmZpZ3VyYXRpb24KICAgIEJSSUNLX1NJWkUgPSA2NAogICAgQ0hVTktTX1BFUl9QQUNLID0g
#3#MTI4CiAgICAKICAgIGJyaWNrX3RvX3BhY2sgPSB7fQogICAgcGFja19oYXNoZXMgPSB7fQogICAg
#3#bGV2ZWxzX21hbmlmZXN0ID0gW10KICAgIAogICAgIyBQcm9jZXNzIGVhY2ggTE9ECiAgICBmb3Ig
#3#bGkgaW4gbG9kX2xldmVsczoKICAgICAgICBsb2RfbnVtID0gbGlbImxvZCJdCiAgICAgICAgVywg
#3#SCwgRCA9IGxpWyJ3aWR0aCJdLCBsaVsiaGVpZ2h0Il0sIGxpWyJkZXB0aCJdCiAgICAgICAgCiAg
#3#ICAgICAgbnggPSBtYXRoLmNlaWwoVyAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnkgPSBtYXRoLmNl
#3#aWwoSCAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnogPSBtYXRoLmNlaWwoRCAvIEJSSUNLX1NJWkUp
#3#CiAgICAgICAgCiAgICAgICAgIyBCdWlsZCBsb2dpY2FsIGdyaWQgb2YgY2h1bmtzIGZvciB0aGlz
#3#IGxldmVsCiAgICAgICAgY2h1bmtzX2dyaWQgPSBbXQogICAgICAgIGZvciBieiBpbiByYW5nZShu
#3#eik6CiAgICAgICAgICAgIGZvciBieSBpbiByYW5nZShueSk6CiAgICAgICAgICAgICAgICBmb3Ig
#3#YnggaW4gcmFuZ2UobngpOgogICAgICAgICAgICAgICAgICAgIG94LCBveSwgb3ogPSBieCAqIEJS
#3#SUNLX1NJWkUsIGJ5ICogQlJJQ0tfU0laRSwgYnogKiBCUklDS19TSVpFCiAgICAgICAgICAgICAg
#3#ICAgICAgZXcgPSBtaW4oQlJJQ0tfU0laRSwgVyAtIG94KQogICAgICAgICAgICAgICAgICAgIGVo
#3#ID0gbWluKEJSSUNLX1NJWkUsIEggLSBveSkKICAgICAgICAgICAgICAgICAgICBlZCA9IG1pbihC
#3#UklDS19TSVpFLCBEIC0gb3opCiAgICAgICAgICAgICAgICAgICAgY2h1bmtzX2dyaWQuYXBwZW5k
#3#KHsKICAgICAgICAgICAgICAgICAgICAgICAgImJ4IjogYngsCiAgICAgICAgICAgICAgICAgICAg
#3#ICAgICJieSI6IGJ5LAogICAgICAgICAgICAgICAgICAgICAgICAiYnoiOiBieiwKICAgICAgICAg
#3#ICAgICAgICAgICAgICAgIm1pbiI6IFtpbnQob3gpLCBpbnQob3kpLCBpbnQob3opXSwKICAgICAg
#3#ICAgICAgICAgICAgICAgICAgIm1heCI6IFtpbnQob3ggKyBldyksIGludChveSArIGVoKSwgaW50
#3#KG96ICsgZWQpXSwKICAgICAgICAgICAgICAgICAgICAgICAgInZhbGlkVm94ZWxDb3VudCI6IGlu
#3#dChldyAqIGVoICogZWQpCiAgICAgICAgICAgICAgICAgICAgfSkKICAgICAgICAgICAgICAgICAg
#3#ICAKICAgICAgICBCQUNLR1JPVU5EX1RIUkVTSE9MRCA9IDAKICAgICAgICBpc19jb3JlID0gW0Zh
#3#bHNlXSAqIGxlbihjaHVua3NfZ3JpZCkKICAgICAgICBmb3IgY19pZHggaW4gcmFuZ2Uobl9jaCk6
#3#CiAgICAgICAgICAgIHRfaWR4ID0gMAogICAgICAgICAgICBiaW5fZmlsZSA9IHRlbXBfZGlyIC8g
#3#ZiJ0e3RfaWR4OjAzZH1fY3tjX2lkeH1fbG9ke2xvZF9udW19LmJpbiIKICAgICAgICAgICAgaWYg
#3#bm90IGJpbl9maWxlLmV4aXN0cygpOgogICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAg
#3#ICAgdm9sdW1lX2RhdGEgPSBucC5tZW1tYXAoCiAgICAgICAgICAgICAgICBzdHIoYmluX2ZpbGUp
#3#LAogICAgICAgICAgICAgICAgZHR5cGU9bnAudWludDgsCiAgICAgICAgICAgICAgICBtb2RlPSJy
#3#IiwKICAgICAgICAgICAgICAgIHNoYXBlPShELCBILCBXKQogICAgICAgICAgICApCiAgICAgICAg
#3#ICAgIGZvciBpLCBjaCBpbiBlbnVtZXJhdGUoY2h1bmtzX2dyaWQpOgogICAgICAgICAgICAgICAg
#3#b3gsIG95LCBveiA9IGNoWyJtaW4iXQogICAgICAgICAgICAgICAgZXgsIGV5LCBleiA9IGNoWyJt
#3#YXgiXQogICAgICAgICAgICAgICAgY2h1bmtfc2xpY2UgPSB2b2x1bWVfZGF0YVtvejpleiwgb3k6
#3#ZXksIG94OmV4XQogICAgICAgICAgICAgICAgaWYgY2h1bmtfc2xpY2Uuc2l6ZSA+IDA6CiAgICAg
#3#ICAgICAgICAgICAgICAgaWYgbnAubWF4KGNodW5rX3NsaWNlKSA+IEJBQ0tHUk9VTkRfVEhSRVNI
#3#T0xEOgogICAgICAgICAgICAgICAgICAgICAgICBpc19jb3JlW2ldID0gVHJ1ZQogICAgICAgICAg
#3#ICBkZWwgdm9sdW1lX2RhdGEKCiAgICAgICAgY29yZV9jb29yZHMgPSBzZXQoKQogICAgICAgIGZv
#3#ciBpLCBjaCBpbiBlbnVtZXJhdGUoY2h1bmtzX2dyaWQpOgogICAgICAgICAgICBpZiBpc19jb3Jl
#3#W2ldOgogICAgICAgICAgICAgICAgY29yZV9jb29yZHMuYWRkKChjaFsiYngiXSwgY2hbImJ5Il0s
#3#IGNoWyJieiJdKSkKCiAgICAgICAgYWN0aXZlX2Nvb3JkcyA9IHNldCgpCiAgICAgICAgZm9yIChi
#3#eCwgYnksIGJ6KSBpbiBjb3JlX2Nvb3JkczoKICAgICAgICAgICAgZm9yIGR4IGluICgtMSwgMCwg
#3#MSk6CiAgICAgICAgICAgICAgICBmb3IgZHkgaW4gKC0xLCAwLCAxKToKICAgICAgICAgICAgICAg
#3#ICAgICBmb3IgZHogaW4gKC0xLCAwLCAxKToKICAgICAgICAgICAgICAgICAgICAgICAgbnhfY29v
#3#cmQgPSBieCArIGR4CiAgICAgICAgICAgICAgICAgICAgICAgIG55X2Nvb3JkID0gYnkgKyBkeQog
#3#ICAgICAgICAgICAgICAgICAgICAgICBuel9jb29yZCA9IGJ6ICsgZHoKICAgICAgICAgICAgICAg
#3#ICAgICAgICAgaWYgMCA8PSBueF9jb29yZCA8IG54IGFuZCAwIDw9IG55X2Nvb3JkIDwgbnkgYW5k
#3#IDAgPD0gbnpfY29vcmQgPCBuejoKICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFjdGl2ZV9j
#3#b29yZHMuYWRkKChueF9jb29yZCwgbnlfY29vcmQsIG56X2Nvb3JkKSkKCiAgICAgICAgYWN0aXZl
#3#X2NodW5rc19ncmlkID0gW2NoIGZvciBjaCBpbiBjaHVua3NfZ3JpZCBpZiAoY2hbImJ4Il0sIGNo
#3#WyJieSJdLCBjaFsiYnoiXSkgaW4gYWN0aXZlX2Nvb3Jkc10KICAgICAgICBwcmludChmIltQQUNL
#3#RVJdIExPRCB7bG9kX251bX06IEdyaWQge254fXh7bnl9eHtuen0gKHtsZW4oY2h1bmtzX2dyaWQp
#3#fSBjaHVua3MsIHtsZW4oYWN0aXZlX2NodW5rc19ncmlkKX0gYWN0aXZlIGFmdGVyIHRocmVzaG9s
#3#ZGluZykiKQoKICAgICAgICAjIFdlIHdpbGwgdHJhY2sgb2NjdXBhbmN5IHVuaW9uIGFjcm9zcyBh
#3#bGwgY2hhbm5lbHMgZm9yIHRoZSBhY3RpdmUgY2h1bmsgZ3JpZAogICAgICAgIG9jY3VwYW5jeV91
#3#bmlvbiA9IFswLjBdICogbGVuKGFjdGl2ZV9jaHVua3NfZ3JpZCkKICAgICAgICAKICAgICAgICAj
#3#IEZvciBlYWNoIGNoYW5uZWwsIG9wZW4gdGhlIHByb2Nlc3NlZCByYXcgYmluYXJ5IHZvbHVtZQog
#3#ICAgICAgIGZvciBjX2lkeCBpbiByYW5nZShuX2NoKToKICAgICAgICAgICAgIyBTaW5jZSBuX3Rw
#3#ID0gMSBieSBkZWZhdWx0IGZvciBmaXhlZCBkYXRhc2V0cywgd2UganVzdCBkbyB0PTAKICAgICAg
#3#ICAgICAgdF9pZHggPSAwCiAgICAgICAgICAgIGJpbl9maWxlID0gdGVtcF9kaXIgLyBmInR7dF9p
#3#ZHg6MDNkfV9je2NfaWR4fV9sb2R7bG9kX251bX0uYmluIgogICAgICAgICAgICAKICAgICAgICAg
#3#ICAgaWYgbm90IGJpbl9maWxlLmV4aXN0cygpOgogICAgICAgICAgICAgICAgcHJpbnQoZiJbV0FS
#3#TklOR10gUHJvY2Vzc2VkIGZpbGUgbm90IGZvdW5kOiB7YmluX2ZpbGV9IikKICAgICAgICAgICAg
#3#ICAgIGNvbnRpbnVlCiAgICAgICAgICAgICAgICAKICAgICAgICAgICAgIyBNZW1vcnkgbWFwIHRo
#3#ZSB2b2x1bWUKICAgICAgICAgICAgdm9sdW1lX2RhdGEgPSBucC5tZW1tYXAoCiAgICAgICAgICAg
#3#ICAgICBzdHIoYmluX2ZpbGUpLAogICAgICAgICAgICAgICAgZHR5cGU9bnAudWludDgsCiAgICAg
#3#ICAgICAgICAgICBtb2RlPSJyIiwKICAgICAgICAgICAgICAgIHNoYXBlPShELCBILCBXKQogICAg
#3#ICAgICAgICApCiAgICAgICAgICAgIAogICAgICAgICAgICAjIFNldHVwIHBhY2tlciBmb3IgdGhp
#3#cyBMT0QgKyBDaGFubmVsCiAgICAgICAgICAgIGNoYW5uZWxfbG9kX2RpciA9IGJyaWNrc19kaXIg
#3#LyBmImxvZHtsb2RfbnVtfSIgLyBmImN7Y19pZHh9IgogICAgICAgICAgICBjaGFubmVsX2xvZF9k
#3#aXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQogICAgICAgICAgICAKICAgICAg
#3#ICAgICAgY3VycmVudF9wYWNrX2lkeCA9IDAKICAgICAgICAgICAgY3VycmVudF9wYWNrX2ZpbGUg
#3#PSBOb25lCiAgICAgICAgICAgIGN1cnJlbnRfcGFja19vZmZzZXQgPSAwCiAgICAgICAgICAgIGNo
#3#dW5rc19pbl9jdXJyZW50X3BhY2sgPSAwCiAgICAgICAgICAgIAogICAgICAgICAgICBkZWYgZ2V0
#3#X3BhY2tfZmlsZShpZHgpOgogICAgICAgICAgICAgICAgcF9maWxlID0gY2hhbm5lbF9sb2RfZGly
#3#IC8gZiJwYWNrX3tpZHg6MDJkfS5iaW4iCiAgICAgICAgICAgICAgICByZXR1cm4gcF9maWxlLCBv
#3#cGVuKHBfZmlsZSwgIndiIikKCiAgICAgICAgICAgIHBhY2tfZmlsZV9wYXRoLCBjdXJyZW50X3Bh
#3#Y2tfZmlsZSA9IGdldF9wYWNrX2ZpbGUoY3VycmVudF9wYWNrX2lkeCkKICAgICAgICAgICAgCiAg
#3#ICAgICAgICAgICMgUHJlcGFyZSBhcmd1bWVudHMgZm9yIG11bHRpcHJvY2Vzc2luZwogICAgICAg
#3#ICAgICB0YXNrcyA9IFtdCiAgICAgICAgICAgIGZvciBpLCBjaCBpbiBlbnVtZXJhdGUoYWN0aXZl
#3#X2NodW5rc19ncmlkKToKICAgICAgICAgICAgICAgIGNoX21ldGEgPSB7ImlkeCI6IGksICJieCI6
#3#IGNoWyJieCJdLCAiYnkiOiBjaFsiYnkiXSwgImJ6IjogY2hbImJ6Il0sICJ2YWxpZFZveGVsQ291
#3#bnQiOiBjaFsidmFsaWRWb3hlbENvdW50Il19CiAgICAgICAgICAgICAgICBveCwgb3ksIG96ID0g
#3#Y2hbIm1pbiJdCiAgICAgICAgICAgICAgICBleCwgZXksIGV6ID0gY2hbIm1heCJdCiAgICAgICAg
#3#ICAgICAgICBjaHVua19kYXRhID0gbnAuY29weSh2b2x1bWVfZGF0YVtvejpleiwgb3k6ZXksIG94
#3#OmV4XSkKICAgICAgICAgICAgICAgIHRhc2tzLmFwcGVuZCgoY2h1bmtfZGF0YSwgY2hfbWV0YSwg
#3#QlJJQ0tfU0laRSkpCiAgICAgICAgICAgICAgICAKICAgICAgICAgICAgZnJvbSB0cWRtIGltcG9y
#3#dCB0cWRtCiAgICAgICAgICAgIHdpdGggUHJvY2Vzc1Bvb2xFeGVjdXRvcihtYXhfd29ya2Vycz1v
#3#cy5jcHVfY291bnQoKSkgYXMgZXhlY3V0b3I6CiAgICAgICAgICAgICAgICAjIFdlIHVzZSBleGVj
#3#dXRvci5tYXAgdG8gbWFpbnRhaW4gdGhlIG9yZGVyIG9mIGFjdGl2ZV9jaHVua3NfZ3JpZAogICAg
#3#ICAgICAgICAgICAgZm9yIHJlc3VsdCBpbiB0cWRtKGV4ZWN1dG9yLm1hcChwcm9jZXNzX2NodW5r
#3#LCB0YXNrcyksIHRvdGFsPWxlbih0YXNrcyksIGRlc2M9IkNvbXByZXNzaW5nIFdlYlAiLCBsZWF2
#3#ZT1GYWxzZSwgYXNjaWk9VHJ1ZSwgbWluaW50ZXJ2YWw9Mi4wKToKICAgICAgICAgICAgICAgICAg
#3#ICBpZHgsIG9jYywgaXNfbm9uX2VtcHR5LCBjb21wcmVzc2VkX2J5dGVzID0gcmVzdWx0CiAgICAg
#3#ICAgICAgICAgICAgICAgb2NjdXBhbmN5X3VuaW9uW2lkeF0gPSBtYXgob2NjdXBhbmN5X3VuaW9u
#3#W2lkeF0sIG9jYykKICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICBpZiBp
#3#c19ub25fZW1wdHk6CiAgICAgICAgICAgICAgICAgICAgICAgICMgQ2hlY2sgaWYgd2UgbmVlZCB0
#3#byByb2xsIG92ZXIgdG8gYSBuZXcgcGFjayBmaWxlCiAgICAgICAgICAgICAgICAgICAgICAgIGlm
#3#IGNodW5rc19pbl9jdXJyZW50X3BhY2sgPj0gQ0hVTktTX1BFUl9QQUNLOgogICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgY3VycmVudF9wYWNrX2ZpbGUuY2xvc2UoKQogICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgIyBSZWNvcmQgaGFzaCBvZiBjb21wbGV0ZWQgcGFjawogICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgcGFja19yZWxfcGF0aCA9IHBhY2tfZmlsZV9wYXRoLnJlbGF0aXZlX3Rv
#3#KGJyaWNrc19kaXIpLmFzX3Bvc2l4KCkKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhY2tf
#3#aGFzaGVzW3BhY2tfcmVsX3BhdGhdID0gaGFzaGxpYi5zaGEyNTYocGFja19maWxlX3BhdGgucmVh
#3#ZF9ieXRlcygpKS5oZXhkaWdlc3QoKQogICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50X3BhY2tfaWR4ICs9IDEKICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgIHBhY2tfZmlsZV9wYXRoLCBjdXJyZW50X3BhY2tfZmlsZSA9IGdldF9w
#3#YWNrX2ZpbGUoY3VycmVudF9wYWNrX2lkeCkKICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1
#3#cnJlbnRfcGFja19vZmZzZXQgPSAwCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaHVua3Nf
#3#aW5fY3VycmVudF9wYWNrID0gMAogICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAg
#3#ICAgICAgICAgICAgICAgICMgV3JpdGUgY29tcHJlc3NlZCBieXRlcyB0byBjdXJyZW50IHBhY2sg
#3#ZmlsZQogICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50X3BhY2tfZmlsZS53cml0ZShjb21w
#3#cmVzc2VkX2J5dGVzKQogICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAg
#3#ICAgICAgIyBTYXZlIG1hcHBpbmcgaW4gYnJpY2tUb1BhY2sKICAgICAgICAgICAgICAgICAgICAg
#3#ICAgY2ggPSBhY3RpdmVfY2h1bmtzX2dyaWRbaWR4XQogICAgICAgICAgICAgICAgICAgICAgICBi
#3#eCwgYnksIGJ6ID0gY2hbImJ4Il0sIGNoWyJieSJdLCBjaFsiYnoiXQogICAgICAgICAgICAgICAg
#3#ICAgICAgICBicmlja19yZWxfa2V5ID0gZiJsb2R7bG9kX251bX0vY3tjX2lkeH0veHtieDowM2R9
#3#X3l7Ynk6MDNkfV96e2J6OjAzZH0ud2VicCIKICAgICAgICAgICAgICAgICAgICAgICAgcGFja19y
#3#ZWxfcGF0aCA9IHBhY2tfZmlsZV9wYXRoLnJlbGF0aXZlX3RvKGJyaWNrc19kaXIpLmFzX3Bvc2l4
#3#KCkKICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgIGJyaWNr
#3#X3RvX3BhY2tbYnJpY2tfcmVsX2tleV0gPSB7CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAi
#3#dXJsIjogcGFja19yZWxfcGF0aCwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICJvZmZzZXQi
#3#OiBpbnQoY3VycmVudF9wYWNrX29mZnNldCksCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAi
#3#bGVuZ3RoIjogaW50KGxlbihjb21wcmVzc2VkX2J5dGVzKSkKICAgICAgICAgICAgICAgICAgICAg
#3#ICAgfQogICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgY3Vy
#3#cmVudF9wYWNrX29mZnNldCArPSBsZW4oY29tcHJlc3NlZF9ieXRlcykKICAgICAgICAgICAgICAg
#3#ICAgICAgICAgY2h1bmtzX2luX2N1cnJlbnRfcGFjayArPSAxCiAgICAgICAgICAgIAogICAgICAg
#3#ICAgICAjIENsb3NlIHRoZSBmaW5hbCBwYWNrIGZpbGUgZm9yIHRoaXMgY2hhbm5lbAogICAgICAg
#3#ICAgICBpZiBjdXJyZW50X3BhY2tfZmlsZToKICAgICAgICAgICAgICAgIGN1cnJlbnRfcGFja19m
#3#aWxlLmNsb3NlKCkKICAgICAgICAgICAgICAgIHBhY2tfcmVsX3BhdGggPSBwYWNrX2ZpbGVfcGF0
#3#aC5yZWxhdGl2ZV90byhicmlja3NfZGlyKS5hc19wb3NpeCgpCiAgICAgICAgICAgICAgICBwYWNr
#3#X2hhc2hlc1twYWNrX3JlbF9wYXRoXSA9IGhhc2hsaWIuc2hhMjU2KHBhY2tfZmlsZV9wYXRoLnJl
#3#YWRfYnl0ZXMoKSkuaGV4ZGlnZXN0KCkKICAgICAgICAgICAgICAgIAogICAgICAgICAgICAjIENs
#3#b3NlIG1lbW1hcCBmaWxlIGhhbmRsZQogICAgICAgICAgICBkZWwgdm9sdW1lX2RhdGEKICAgICAg
#3#ICAgICAgCiAgICAgICAgIyBCdWlsZCBsZXZlbCBjaHVua3MgbGlzdCBmb3IgbWFuaWZlc3QKICAg
#3#ICAgICBtYW5pZmVzdF9jaHVua3MgPSBbXQogICAgICAgIG5vbl9lbXB0eV9jb3VudCA9IDAKICAg
#3#ICAgICBmb3IgaSwgY2ggaW4gZW51bWVyYXRlKGFjdGl2ZV9jaHVua3NfZ3JpZCk6CiAgICAgICAg
#3#ICAgIGlzX25vbl9lbXB0eSA9IG9jY3VwYW5jeV91bmlvbltpXSA+IDAuMDAwNQogICAgICAgICAg
#3#ICBpZiBpc19ub25fZW1wdHk6CiAgICAgICAgICAgICAgICBub25fZW1wdHlfY291bnQgKz0gMQog
#3#ICAgICAgICAgICBtYW5pZmVzdF9jaHVua3MuYXBwZW5kKHsKICAgICAgICAgICAgICAgICJpZCI6
#3#IGYie2NoWydieiddfV97Y2hbJ2J5J119X3tjaFsnYngnXX0iLAogICAgICAgICAgICAgICAgIm1p
#3#biI6IGNoWyJtaW4iXSwKICAgICAgICAgICAgICAgICJtYXgiOiBjaFsibWF4Il0sCiAgICAgICAg
#3#ICAgICAgICAib2NjdXBpZWRSYXRpbyI6IHJvdW5kKG9jY3VwYW5jeV91bmlvbltpXSwgNiksCiAg
#3#ICAgICAgICAgICAgICAibm9uRW1wdHkiOiBpc19ub25fZW1wdHkKICAgICAgICAgICAgfSkKICAg
#3#ICAgICAgICAgCiAgICAgICAgbGV2ZWxzX21hbmlmZXN0LmFwcGVuZCh7CiAgICAgICAgICAgICJs
#3#ZXZlbCI6IGxvZF9udW0sCiAgICAgICAgICAgICJzY2FsZSI6IDEuMCAvICgyICoqIGxvZF9udW0p
#3#LAogICAgICAgICAgICAiZGltZW5zaW9ucyI6IHsieCI6IFcsICJ5IjogSCwgInoiOiBEfSwKICAg
#3#ICAgICAgICAgImJyaWNrU2l6ZSI6IEJSSUNLX1NJWkUsCiAgICAgICAgICAgICJncmlkU2l6ZSI6
#3#IHsieCI6IG54LCAieSI6IG55LCAieiI6IG56fSwKICAgICAgICAgICAgImJyaWNrQ291bnQiOiBs
#3#ZW4oY2h1bmtzX2dyaWQpLAogICAgICAgICAgICAiY2h1bmtzIjogbWFuaWZlc3RfY2h1bmtzLAog
#3#ICAgICAgICAgICAibm9uRW1wdHlDb3VudCI6IG5vbl9lbXB0eV9jb3VudAogICAgICAgIH0pCgog
#3#ICAgIyBBc3NlbWJsZSBhbmQgd3JpdGUgbWFuaWZlc3QuanNvbgogICAgbWFuaWZlc3QgPSB7CiAg
#3#ICAgICAgInZlcnNpb24iOiAyLAogICAgICAgICJzY2hlbWEiOiAiaXJpYmhtLWJyaWNrcy12MiIs
#3#CiAgICAgICAgImRhdGFzZXQiOiBvdXRwdXRfZGlyLm5hbWUsCiAgICAgICAgImRhdGFzZXRUeXBl
#3#IjogImZpeGVkIiwKICAgICAgICAiY2hhbm5lbHMiOiBuX2NoLAogICAgICAgICJicmlja1NpemUi
#3#OiBCUklDS19TSVpFLAogICAgICAgICJicmlja1BhY2tpbmciOiB7Im1vZGUiOiAiZ3JpZCIsICJj
#3#b2xzIjogOCwgInJvd3MiOiA4fSwKICAgICAgICAidm94ZWxTaXplIjogdm94ZWxfc2l6ZSwKICAg
#3#ICAgICAiY3JlYXRlZEF0IjogX19pbXBvcnRfXygiZGF0ZXRpbWUiKS5kYXRldGltZS5ub3coKS5p
#3#c29mb3JtYXQoKSwKICAgICAgICAibGV2ZWxzIjogbGV2ZWxzX21hbmlmZXN0LAogICAgICAgICJo
#3#aXN0b2dyYW1zIjogW10sICMgV2lsbCBiZSBwb3B1bGF0ZWQgYnkgc3RlcCA0IG9yIGR5bmFtaWMg
#3#c2NhbgogICAgICAgICJoYXNoZXMiOiB7fSwgICAgICMgTGVmdCBlbXB0eSBhcyB3ZSB1c2UgcGFj
#3#ayB0cmFuc3BvcnQKICAgICAgICAidGltZXBvaW50cyI6IE5vbmUsCiAgICAgICAgImJyaWNrVHJh
#3#bnNwb3J0IjogewogICAgICAgICAgICAibW9kZSI6ICJwYWNrcyIsCiAgICAgICAgICAgICJlbmNv
#3#ZGluZyI6ICJ3ZWJwLWxvc3NsZXNzIiwKICAgICAgICAgICAgInBhY2tTaXplIjogQ0hVTktTX1BF
#3#Ul9QQUNLLAogICAgICAgICAgICAiYnJpY2tUb1BhY2siOiBicmlja190b19wYWNrLAogICAgICAg
#3#ICAgICAicGFja0hhc2hlcyI6IHBhY2tfaGFzaGVzCiAgICAgICAgfQogICAgfQogICAgCiAgICB3
#3#aXRoIG9wZW4oYnJpY2tzX2RpciAvICJtYW5pZmVzdC5qc29uIiwgInciLCBlbmNvZGluZz0idXRm
#3#LTgiKSBhcyBmbToKICAgICAgICBqc29uLmR1bXAobWFuaWZlc3QsIGZtLCBpbmRlbnQ9MikKICAg
#3#ICAgICAKICAgIHByaW50KGYiW1BBQ0tFUl0gV3JvdGUgbWFuaWZlc3QuanNvbiB0byB7YnJpY2tz
#3#X2RpciAvICdtYW5pZmVzdC5qc29uJ30iKQoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAg
#3#IGlmIGxlbihzeXMuYXJndikgPCAzOgogICAgICAgIHByaW50KCJVc2FnZTogcHl0aG9uIDMtY2h1
#3#bmtfcGFja2VyLnB5IDx0ZW1wX2Rpcj4gPG91dHB1dF9kaXI+IikKICAgICAgICBzeXMuZXhpdCgx
#3#KQogICAgICAgIAogICAgdGVtcF9kaXIgPSBQYXRoKHN5cy5hcmd2WzFdKQogICAgb3V0cHV0X2Rp
#3#ciA9IFBhdGgoc3lzLmFyZ3ZbMl0pCiAgICAKICAgIHRyeToKICAgICAgICBidWlsZF9wYWNrcyh0
#3#ZW1wX2Rpciwgb3V0cHV0X2RpcikKICAgICAgICBwcmludChmIltQQUNLRVJdIENodW5rIHBhY2th
#3#Z2luZyBjb21wbGV0ZS4iKQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOgogICAgICAgIGltcG9y
#3#dCB0cmFjZWJhY2sKICAgICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkKICAgICAgICBwcmludChm
#3#IltFUlJPUl0gQ2h1bmsgcGFja2FnaW5nIGZhaWxlZDoge2V9IiwgZmlsZT1zeXMuc3RkZXJyKQog
#3#ICAgICAgIHN5cy5leGl0KDEpCg==
:: ---- [4] 4-catalog_generator.py (6711 octets) ----
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
#4#CiAgICBsb2RfaCA9IGxvZF9sZXZlbHNbLTFdWyJoZWlnaHQiXQogICAgCiAgICBoaXN0b2dyYW1z
#4#ID0gW10KICAgIHByaW50KGYiW0NBVEFMT0ddIENvbXB1dGluZyBoaXN0b2dyYW1zIG9uIExPRCB7
#4#aGlnaGVzdF9sb2R9ICh7bG9kX3d9eHtsb2RfaH14e0R9KS4uLiIpCiAgICAKICAgIGZvciBjX2lk
#4#eCBpbiByYW5nZShuX2NoKToKICAgICAgICBiaW5fZmlsZSA9IHRlbXBfZGlyIC8gZiJ0MDAwX2N7
#4#Y19pZHh9X2xvZHtoaWdoZXN0X2xvZH0uYmluIgogICAgICAgIGlmIGJpbl9maWxlLmV4aXN0cygp
#4#OgogICAgICAgICAgICB2b2xfZGF0YSA9IG5wLmZyb21maWxlKHN0cihiaW5fZmlsZSksIGR0eXBl
#4#PW5wLnVpbnQ4KQogICAgICAgICAgICBjb3VudHMsIGVkZ2VzID0gbnAuaGlzdG9ncmFtKHZvbF9k
#4#YXRhLCBiaW5zPTY0LCByYW5nZT0oMCwgMjU1KSkKICAgICAgICAgICAgCiAgICAgICAgICAgIG1l
#4#YW5fdmFsID0gZmxvYXQodm9sX2RhdGEubWVhbigpKSBpZiB2b2xfZGF0YS5zaXplIGVsc2UgMC4w
#4#CiAgICAgICAgICAgIHN0ZF92YWwgPSBmbG9hdCh2b2xfZGF0YS5zdGQoKSkgaWYgdm9sX2RhdGEu
#4#c2l6ZSBlbHNlIDAuMAogICAgICAgICAgICBtYXhfdmFsID0gaW50KHZvbF9kYXRhLm1heCgpKSBp
#4#ZiB2b2xfZGF0YS5zaXplIGVsc2UgMAogICAgICAgICAgICAKICAgICAgICAgICAgaGlzdG9ncmFt
#4#cy5hcHBlbmQoewogICAgICAgICAgICAgICAgImNvdW50cyI6IGNvdW50cy5hc3R5cGUobnAuaW50
#4#NjQpLnRvbGlzdCgpLAogICAgICAgICAgICAgICAgImVkZ2VzIjogZWRnZXMuYXN0eXBlKG5wLmZs
#4#b2F0NjQpLnRvbGlzdCgpLAogICAgICAgICAgICAgICAgInRvdGFsIjogaW50KHZvbF9kYXRhLnNp
#4#emUpLAogICAgICAgICAgICAgICAgIm1heCI6IG1heF92YWwsCiAgICAgICAgICAgICAgICAibWVh
#4#biI6IG1lYW5fdmFsLAogICAgICAgICAgICAgICAgInN0ZCI6IHN0ZF92YWwsCiAgICAgICAgICAg
#4#ICAgICAiYmFja2dyb3VuZEZsb29yIjogMAogICAgICAgICAgICB9KQogICAgICAgICAgICBkZWwg
#4#dm9sX2RhdGEKICAgICAgICBlbHNlOgogICAgICAgICAgICBwcmludChmIltXQVJOSU5HXSBCaW4g
#4#ZmlsZSBmb3IgaGlzdG9ncmFtIG5vdCBmb3VuZDoge2Jpbl9maWxlfSIpCiAgICAgICAgICAgIGhp
#4#c3RvZ3JhbXMuYXBwZW5kKHsKICAgICAgICAgICAgICAgICJjb3VudHMiOiBbMF0gKiA2NCwKICAg
#4#ICAgICAgICAgICAgICJlZGdlcyI6IGxpc3QocmFuZ2UoNjUpKSwKICAgICAgICAgICAgICAgICJ0
#4#b3RhbCI6IDAsCiAgICAgICAgICAgICAgICAibWF4IjogMCwKICAgICAgICAgICAgICAgICJtZWFu
#4#IjogMC4wLAogICAgICAgICAgICAgICAgInN0ZCI6IDAuMCwKICAgICAgICAgICAgICAgICJiYWNr
#4#Z3JvdW5kRmxvb3IiOiAwCiAgICAgICAgICAgIH0pCgogICAgIyAyLiBVcGRhdGUgYnJpY2tzL21h
#4#bmlmZXN0Lmpzb24gd2l0aCBjYWxjdWxhdGVkIGhpc3RvZ3JhbXMKICAgIG1hbmlmZXN0X3BhdGgg
#4#PSBvdXRwdXRfZGlyIC8gImJyaWNrcyIgLyAibWFuaWZlc3QuanNvbiIKICAgIGlmIG1hbmlmZXN0
#4#X3BhdGguZXhpc3RzKCk6CiAgICAgICAgd2l0aCBvcGVuKG1hbmlmZXN0X3BhdGgsICJyIiwgZW5j
#4#b2Rpbmc9InV0Zi04IikgYXMgZjoKICAgICAgICAgICAgbWFuaWZlc3QgPSBqc29uLmxvYWQoZikK
#4#ICAgICAgICBtYW5pZmVzdFsiaGlzdG9ncmFtcyJdID0gaGlzdG9ncmFtcwogICAgICAgIHdpdGgg
#4#b3BlbihtYW5pZmVzdF9wYXRoLCAidyIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGY6CiAgICAgICAg
#4#ICAgIGpzb24uZHVtcChtYW5pZmVzdCwgZiwgaW5kZW50PTIpCiAgICAgICAgcHJpbnQoZiJbQ0FU
#4#QUxPR10gSW5qZWN0ZWQgaGlzdG9ncmFtcyBpbnRvIG1hbmlmZXN0Lmpzb24iKQogICAgZWxzZToK
#4#ICAgICAgICBwcmludChmIltXQVJOSU5HXSBtYW5pZmVzdC5qc29uIG5vdCBmb3VuZCB0byB1cGRh
#4#dGUgaGlzdG9ncmFtcy4iKQoKICAgICMgMy4gQ2FsY3VsYXRlIFBoeXNpY2FsIENhbGlicmF0aW9u
#4#CiAgICB2eCA9IHZveGVsX3NpemVbIngiXQogICAgdnkgPSB2b3hlbF9zaXplWyJ5Il0KICAgIHZ6
#4#ID0gdm94ZWxfc2l6ZVsieiJdCiAgICAKICAgICMgV2UgZXN0aW1hdGUgb3B0aWNhbCB0aGlja25l
#4#c3MgYXMgc2xpY2Ugc3BhY2luZyAodm94ZWxaKQogICAgc2xpY2VfdGhpY2tuZXNzID0gdnoKICAg
#4#IHBoeXNpY2FsX3NpemUgPSB7CiAgICAgICAgIngiOiBXICogdngsCiAgICAgICAgInkiOiBIICog
#4#dnksCiAgICAgICAgInoiOiBEICogdnosCiAgICAgICAgInNsaWNlVGhpY2tuZXNzIjogc2xpY2Vf
#4#dGhpY2tuZXNzLAogICAgICAgICJ2b3hlbFgiOiB2eCwKICAgICAgICAidm94ZWxZIjogdnksCiAg
#4#ICAgICAgInZveGVsWiI6IHZ6CiAgICB9CiAgICAKICAgICMgU2V0dXAgZGVmYXVsdCBjaGFubmVs
#4#cyBpbmZvIGZvciBtZXRhZGF0YS5qc29uCiAgICBjaGFubmVsc19pbmZvID0gW10KICAgIGZvciBp
#4#IGluIHJhbmdlKG5fY2gpOgogICAgICAgIGNoX25hbWUgPSBjaGFubmVsX25hbWVzW2ldIGlmIGkg
#4#PCBsZW4oY2hhbm5lbF9uYW1lcykgZWxzZSBmIkNoYW5uZWwge2krMX0iCiAgICAgICAgY2hhbm5l
#4#bHNfaW5mby5hcHBlbmQoewogICAgICAgICAgICAibmFtZSI6IGNoX25hbWUsCiAgICAgICAgICAg
#4#ICJjb2xvciI6IENPTE9SU1tpICUgbGVuKENPTE9SUyldLAogICAgICAgICAgICAibWluIjogMC4w
#4#LAogICAgICAgICAgICAibWF4IjogMS4wLAogICAgICAgICAgICAiZ2FtbWEiOiAxLjAKICAgICAg
#4#ICB9KQoKICAgICMgQnVpbGQgbWV0YWRhdGEuanNvbgogICAgbWV0YWRhdGEgPSB7CiAgICAgICAg
#4#ImlkIjogZiJ7dHlwZV9kaXJ9L3tkYXRhc2V0X25hbWV9IiwKICAgICAgICAibmFtZSI6IGRhdGFz
#4#ZXRfbmFtZSwKICAgICAgICAidHlwZSI6IHR5cGVfZGlyLAogICAgICAgICJzdGFnZSI6IHN0YWdl
#4#LAogICAgICAgICJzdGFnZU51bWVyaWMiOiBzdGFnZV9udW0sCiAgICAgICAgImVtYnJ5byI6IGVt
#4#YnJ5bywKICAgICAgICAiZGltZW5zaW9ucyI6IHsKICAgICAgICAgICAgIngiOiBXLAogICAgICAg
#4#ICAgICAieSI6IEgsCiAgICAgICAgICAgICJ6IjogRCwKICAgICAgICAgICAgImMiOiBuX2NoLAog
#4#ICAgICAgICAgICAidCI6IG5fdHAKICAgICAgICB9LAogICAgICAgICJ2b3hlbF9zaXplIjogdm94
#4#ZWxfc2l6ZSwKICAgICAgICAicGh5c2ljYWxTaXplVW0iOiBwaHlzaWNhbF9zaXplLAogICAgICAg
#4#ICJjYWxpYnJhdGlvblN0YXR1cyI6ICJleGFjdCIgaWYgKHZ4IGFuZCB2eSBhbmQgdnopIGVsc2Ug
#4#Im1ldGFkYXRhLW1pc3NpbmciLAogICAgICAgICJjYWxpYnJhdGlvbk5vdGUiOiAiVm94ZWwgbWV0
#4#YWRhdGEgd2FzIHN1Y2Nlc3NmdWxseSBleHRyYWN0ZWQuIiBpZiAodnggYW5kIHZ5IGFuZCB2eikg
#4#ZWxzZSAiQ2FsaWJyYXRpb24gbWV0YWRhdGEgbWlzc2luZy4iLAogICAgICAgICJjaGFubmVscyI6
#4#IGNoYW5uZWxzX2luZm8sCiAgICAgICAgImNyZWF0ZWQiOiBfX2ltcG9ydF9fKCJkYXRldGltZSIp
#4#LmRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpLAogICAgICAgICJsYXN0TW9kaWZpZWQiOiBfX2lt
#4#cG9ydF9fKCJkYXRldGltZSIpLmRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpLAogICAgICAgICJj
#4#b25maWd1cmVkIjogVHJ1ZSwKICAgICAgICAiZm9sZGVyTmFtZSI6IGRhdGFzZXRfbmFtZSwKICAg
#4#ICAgICAiZGVzY3JpcHRpb24iOiBmIkNvbmZvY2FsIGltYWdpbmcgc3RhY2s6IHtzdGFnZX0gZml4
#4#ZWQgZW1icnlvLCB7RH0gc2xpY2VzLCB7bl9jaH0gY2hhbm5lbHMuIiwKICAgICAgICAidGh1bWJu
#4#YWlsIjogZiJ7cmVsX3BhdGhfc3RyfS90aHVtYm5haWwud2VicCIgaWYgKG91dHB1dF9kaXIgLyAi
#4#dGh1bWJuYWlsLndlYnAiKS5leGlzdHMoKSBlbHNlIE5vbmUsCiAgICAgICAgInZvbHVtZVNvdXJj
#4#ZXMiOiBbCiAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICJraW5kIjogImJyaWNrcyIsCiAg
#4#ICAgICAgICAgICAgICAibGFiZWwiOiAiQ2h1bmtlZCBicmlja3MgKDY0wrMpIiwKICAgICAgICAg
#4#ICAgICAgICJwcmlvcml0eSI6IC0xLAogICAgICAgICAgICAgICAgImF2YWlsYWJsZSI6IFRydWUs
#4#CiAgICAgICAgICAgICAgICAibXVsdGlzY2FsZSI6IFRydWUsCiAgICAgICAgICAgICAgICAicGF0
#4#aCI6IHJlbF9wYXRoX3N0ciwKICAgICAgICAgICAgICAgICJtYW5pZmVzdFBhdGgiOiBmIntyZWxf
#4#cGF0aF9zdHJ9L2JyaWNrcy9tYW5pZmVzdC5qc29uIgogICAgICAgICAgICB9CiAgICAgICAgXQog
#4#ICAgfQogICAgCiAgICB3aXRoIG9wZW4ob3V0cHV0X2RpciAvICJtZXRhZGF0YS5qc29uIiwgInci
#4#LCBlbmNvZGluZz0idXRmLTgiKSBhcyBmbToKICAgICAgICBqc29uLmR1bXAobWV0YWRhdGEsIGZt
#4#LCBpbmRlbnQ9MiwgZW5zdXJlX2FzY2lpPUZhbHNlKQogICAgICAgIAogICAgcHJpbnQoZiJbQ0FU
#4#QUxPR10gV3JvdGUgbWV0YWRhdGEuanNvbiB0byB7b3V0cHV0X2RpciAvICdtZXRhZGF0YS5qc29u
#4#J30iKQoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAgIGlmIGxlbihzeXMuYXJndikgPCAz
#4#OgogICAgICAgIHByaW50KCJVc2FnZTogcHl0aG9uIDQtY2F0YWxvZ19nZW5lcmF0b3IucHkgPHRl
#4#bXBfZGlyPiA8b3V0cHV0X2Rpcj4iKQogICAgICAgIHN5cy5leGl0KDEpCiAgICAgICAgCiAgICB0
#4#ZW1wX2RpciA9IFBhdGgoc3lzLmFyZ3ZbMV0pCiAgICBvdXRwdXRfZGlyID0gUGF0aChzeXMuYXJn
#4#dlsyXSkKICAgIAogICAgdHJ5OgogICAgICAgIGdlbmVyYXRlX2NhdGFsb2dfbWV0YWRhdGEodGVt
#4#cF9kaXIsIG91dHB1dF9kaXIpCiAgICAgICAgcHJpbnQoZiJbQ0FUQUxPR10gQ2F0YWxvZyBtZXRh
#4#ZGF0YSBnZW5lcmF0aW9uIGNvbXBsZXRlLiIpCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6CiAg
#4#ICAgICAgaW1wb3J0IHRyYWNlYmFjawogICAgICAgIHRyYWNlYmFjay5wcmludF9leGMoKQogICAg
#4#ICAgIHByaW50KGYiW0VSUk9SXSBDYXRhbG9nIG1ldGFkYXRhIGdlbmVyYXRpb24gZmFpbGVkOiB7
#4#ZX0iLCBmaWxlPXN5cy5zdGRlcnIpCiAgICAgICAgc3lzLmV4aXQoMSkK
