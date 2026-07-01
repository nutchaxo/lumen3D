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
set "PP_VERSION=0.14.1"
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
:: ---- [0] run_preprocess.py (13907 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KaW1wb3J0IGFyZ3BhcnNlDQppbXBvcnQgZm5tYXRjaA0K
#0#aW1wb3J0IGpzb24NCmltcG9ydCBvcw0KaW1wb3J0IHNodXRpbA0KaW1wb3J0IHNpZ25hbA0KaW1w
#0#b3J0IHN1YnByb2Nlc3MNCmltcG9ydCBzeXMNCmltcG9ydCB0cmFjZWJhY2sNCmZyb20gZGF0ZXRp
#0#bWUgaW1wb3J0IGRhdGV0aW1lDQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgNCmltcG9ydCBudW1w
#0#eSBhcyBucA0KZnJvbSBQSUwgaW1wb3J0IEltYWdlDQoNCl9fdmVyc2lvbl9fID0gIjAuMTQuMSIN
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
#0#DQoNCg0KRE9XTkxPQURfU0NSSVBUX05BTUUgPSAiYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSIN
#0#Cg0KZGVmIF9yZXNvbHZlX2Rvd25sb2FkX3NjcmlwdCgpOg0KICAgICIiIlRoZSBkb3dubG9hZC1i
#0#dW5kbGUgdG9vbCBzaXRzIGluIHRvb2xzLyBpbiB0aGUgcmVwbywgYnV0IGlzIGV4dHJhY3RlZCBu
#0#ZXh0DQogICAgdG8gdGhpcyBzY3JpcHQgYnkgdGhlIHNlbGYtY29udGFpbmVkIGxhdW5jaGVyIOKA
#0#lCBhY2NlcHQgZWl0aGVyIGxvY2F0aW9uLiIiIg0KICAgIGZvciBjYW5kIGluIChTQ1JJUFRfRElS
#0#IC8gRE9XTkxPQURfU0NSSVBUX05BTUUsDQogICAgICAgICAgICAgICAgIFNDUklQVF9ESVIucGFy
#0#ZW50IC8gInRvb2xzIiAvIERPV05MT0FEX1NDUklQVF9OQU1FKToNCiAgICAgICAgaWYgY2FuZC5l
#0#eGlzdHMoKToNCiAgICAgICAgICAgIHJldHVybiBjYW5kLnJlc29sdmUoKQ0KICAgIHJldHVybiBO
#0#b25lDQoNCmRlZiBwcm9jZXNzX2ltc19maWxlKGltc19wYXRoOiBQYXRoLCBvdXRwdXRfcm9vdDog
#0#UGF0aCwgaWR4OiBpbnQgPSAwLCB0b3RhbDogaW50ID0gMCwNCiAgICAgICAgICAgICAgICAgICAg
#0#IHdpdGhfZG93bmxvYWRzOiBib29sID0gRmFsc2UpIC0+IE5vbmU6DQogICAgZGF0YXNldF9uYW1l
#0#ID0gaW1zX3BhdGguc3RlbQ0KICAgIGNvdW50ZXIgPSBmIlt7aWR4fS97dG90YWx9XSAiIGlmIHRv
#0#dGFsIGVsc2UgIiINCiAgICBwcmludCgpDQogICAgcHJpbnQoX2hkcihmIj4+IHtjb3VudGVyfXtk
#0#YXRhc2V0X25hbWV9IikpDQogICAgcHJpbnQoX2RpbShmIiAgIHNvdXJjZSA6IHtpbXNfcGF0aH0i
#0#KSkNCiAgICB0MCA9IGRhdGV0aW1lLm5vdygpDQogICAgDQogICAgIyBTZXR1cCBkaXJlY3Rvcmll
#0#cw0KICAgIHRlbXBfZGlyID0gb3V0cHV0X3Jvb3QgLyBmIi50ZW1wX3ByZXByb2Nlc3Nfe2RhdGFz
#0#ZXRfbmFtZX0iDQogICAgaWYgdGVtcF9kaXIuZXhpc3RzKCk6DQogICAgICAgIHNodXRpbC5ybXRy
#0#ZWUodGVtcF9kaXIpDQogICAgdGVtcF9kaXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1U
#0#cnVlKQ0KICAgIA0KICAgICMgVGFyZ2V0IGZpeGVkIGRhdGFzZXQgZGlyDQogICAgZGF0YXNldF9v
#0#dXRwdXRfZGlyID0gb3V0cHV0X3Jvb3QgLyAiZml4ZWQiIC8gZGF0YXNldF9uYW1lDQogICAgaWYg
#0#ZGF0YXNldF9vdXRwdXRfZGlyLmV4aXN0cygpOg0KICAgICAgICBicmlja3NfZGlyID0gZGF0YXNl
#0#dF9vdXRwdXRfZGlyIC8gImJyaWNrcyINCiAgICAgICAgaWYgYnJpY2tzX2Rpci5leGlzdHMoKToN
#0#CiAgICAgICAgICAgIHNodXRpbC5ybXRyZWUoYnJpY2tzX2RpcikNCiAgICBkYXRhc2V0X291dHB1
#0#dF9kaXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQ0KICAgIA0KICAgIHRyeToN
#0#CiAgICAgICAgIyBTdGVwIDE6IEV4dHJhY3Rpb24gb2YgbWV0YWRhdGENCiAgICAgICAgdGVtcF9t
#0#ZXRhX2pzb24gPSB0ZW1wX2RpciAvICJtZXRhLmpzb24iDQogICAgICAgIHJ1bl9zdGVwKCIxLWlt
#0#c19tZXRhZGF0YS5weSIsIHN0cihpbXNfcGF0aCksIHN0cih0ZW1wX21ldGFfanNvbikpDQogICAg
#0#ICAgIA0KICAgICAgICAjIFN0ZXAgMjogTm9ybWFsaXphdGlvbiwgQmFja2dyb3VuZCBzdWJ0cmFj
#0#dGlvbiwgRG93bnNjYWxpbmcNCiAgICAgICAgcnVuX3N0ZXAoIjItaW1hZ2VfcHJvY2Vzc29yLnB5
#0#Iiwgc3RyKGltc19wYXRoKSwgc3RyKHRlbXBfbWV0YV9qc29uKSwgc3RyKHRlbXBfZGlyKSkNCiAg
#0#ICAgICAgDQogICAgICAgICMgU3RlcCAzOiBDb21wdXRlIHRodW1ibmFpbCBNSVANCiAgICAgICAg
#0#d2l0aCBvcGVuKHRlbXBfZGlyIC8gInByb2Nlc3NpbmdfbWV0YS5qc29uIiwgInIiLCBlbmNvZGlu
#0#Zz0idXRmLTgiKSBhcyBmbToNCiAgICAgICAgICAgIHByb2NfbWV0YSA9IGpzb24ubG9hZChmbSkN
#0#CiAgICAgICAgYnVpbGRfdGh1bWJuYWlsKHRlbXBfZGlyLCBkYXRhc2V0X291dHB1dF9kaXIsIHBy
#0#b2NfbWV0YSkNCiAgICAgICAgDQogICAgICAgICMgU3RlcCA0OiBDaHVua2luZyA2NMKzICYgUGFj
#0#ayBidWlsZGluZw0KICAgICAgICBydW5fc3RlcCgiMy1jaHVua19wYWNrZXIucHkiLCBzdHIodGVt
#0#cF9kaXIpLCBzdHIoZGF0YXNldF9vdXRwdXRfZGlyKSkNCiAgICAgICAgDQogICAgICAgICMgU3Rl
#0#cCA1OiBDYXRhbG9nIG1ldGFkYXRhIChkYXRhc2V0Lmpzb24gLyBtZXRhZGF0YS5qc29uKQ0KICAg
#0#ICAgICBydW5fc3RlcCgiNC1jYXRhbG9nX2dlbmVyYXRvci5weSIsIHN0cih0ZW1wX2RpciksIHN0
#0#cihkYXRhc2V0X291dHB1dF9kaXIpKQ0KDQogICAgICAgICMgU3RlcCA2IChvcHRpb25hbCk6IGRv
#0#d25sb2FkLyBidW5kbGUg4oCUIGFyY2hpdmUsIG9yaWdpbmFsIC5pbXMsIE9NRS1USUZGLA0KICAg
#0#ICAgICAjIHBlci1jaGFubmVsIE1JUHMsIFJFQURNRS4gUnVucyBhZnRlciBzdGVwIDQgc28gbWV0
#0#YWRhdGEuanNvbiBleGlzdHMuIFRoZQ0KICAgICAgICAjIHNvdXJjZSAuaW1zIGlzIHRoZSBvbmUg
#0#YmVpbmcgcHJvY2Vzc2VkLCBzbyBwb2ludCB0aGUgdG9vbCBhdCBpdHMgZm9sZGVyLg0KICAgICAg
#0#ICBpZiB3aXRoX2Rvd25sb2FkczoNCiAgICAgICAgICAgIGRsX3NjcmlwdCA9IF9yZXNvbHZlX2Rv
#0#d25sb2FkX3NjcmlwdCgpDQogICAgICAgICAgICBpZiBkbF9zY3JpcHQgaXMgTm9uZToNCiAgICAg
#0#ICAgICAgICAgICBwcmludChfd2FybihmIiAgIFshXSB7RE9XTkxPQURfU0NSSVBUX05BTUV9IGlu
#0#dHJvdXZhYmxlIOKAlCBkb3dubG9hZC8gaWdub3JlIikpDQogICAgICAgICAgICBlbHNlOg0KICAg
#0#ICAgICAgICAgICAgIHJ1bl9zY3JpcHQoZGxfc2NyaXB0LA0KICAgICAgICAgICAgICAgICAgICAg
#0#ICAgICAgIi0tZGF0YS13ZWIiLCBzdHIob3V0cHV0X3Jvb3QpLA0KICAgICAgICAgICAgICAgICAg
#0#ICAgICAgICAgIi0tcmF3LWRpciIsIHN0cihpbXNfcGF0aC5wYXJlbnQpLA0KICAgICAgICAgICAg
#0#ICAgICAgICAgICAgICAgIi0tZGF0YXNldHMiLCBkYXRhc2V0X25hbWUsDQogICAgICAgICAgICAg
#0#ICAgICAgICAgICAgICBsYWJlbD0iZG93bmxvYWQvIChhcmNoaXZlLCBPTUUtVElGRiwgTUlQKSIp
#0#DQoNCiAgICAgICAgZWxhcHNlZCA9IChkYXRldGltZS5ub3coKSAtIHQwKS50b3RhbF9zZWNvbmRz
#0#KCkNCiAgICAgICAgcHJpbnQoX29rKGYiICAgW09LXSB7ZGF0YXNldF9uYW1lfSB0ZXJtaW5lIGVu
#0#IHtlbGFwc2VkOi4wZn1zIikpDQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOg0KICAgICAgICBw
#0#cmludChfZXJyKGYiICAgW1hdIHtkYXRhc2V0X25hbWV9IDoge2V9IiksIGZpbGU9c3lzLnN0ZGVy
#0#cikNCiAgICAgICAgdHJhY2ViYWNrLnByaW50X2V4YygpDQogICAgZmluYWxseToNCiAgICAgICAg
#0#IyBDbGVhbiB1cCB0ZW1wb3JhcnkgcHJvY2Vzc2luZyBiaW5hcnkgZmlsZXMgdG8gZnJlZSBzcGFj
#0#ZS4NCiAgICAgICAgIyBpZ25vcmVfZXJyb3JzOiBvbiBhIEN0cmwrQyB0ZWFyZG93biBhIGp1c3Qt
#0#a2lsbGVkIHdvcmtlciBtYXkgc3RpbGwgaG9sZCBhDQogICAgICAgICMgaGFuZGxlIGZvciBhIGZl
#0#dyBtcyDigJQgbmV2ZXIgbGV0IGNsZWFudXAgbWFzayB0aGUgaW50ZXJydXB0aW9uLg0KICAgICAg
#0#ICBpZiB0ZW1wX2Rpci5leGlzdHMoKToNCiAgICAgICAgICAgIHNodXRpbC5ybXRyZWUodGVtcF9k
#0#aXIsIGlnbm9yZV9lcnJvcnM9VHJ1ZSkNCg0KZGVmIG1haW4oKToNCiAgICBwYXJzZXIgPSBhcmdw
#0#YXJzZS5Bcmd1bWVudFBhcnNlcihkZXNjcmlwdGlvbj0iSVJJQkhNIE1pY3Jvc2NvcHkgUHJlcHJv
#0#Y2Vzc2luZyBVbmlmaWVkIFBpcGVsaW5lIikNCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLWlu
#0#cHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iSW5wdXQgZGlyZWN0b3J5IGNvbnRhaW5pbmcgcmF3
#0#IC5pbXMgZmlsZXMuIikNCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLW91dHB1dCIsIHJlcXVp
#0#cmVkPVRydWUsIGhlbHA9Ik91dHB1dCBEQVRBX1dFQiBkaXJlY3Rvcnkgb2YgdGhlIHdlYiBwbGF0
#0#Zm9ybS4iKQ0KICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0tb25seSIsIGRlZmF1bHQ9Tm9uZSwg
#0#aGVscD0iR2xvYiBwYXR0ZXJuIHRvIGZpbHRlciBmaWxlcyB0byBwcm9jZXNzIChlLmcuICcqRTgq
#0#JykuIikNCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLXdpdGgtZG93bmxvYWRzIiwgYWN0aW9u
#0#PSJzdG9yZV90cnVlIiwNCiAgICAgICAgICAgICAgICAgICAgICAgIGhlbHA9IkFmdGVyIGVhY2gg
#0#ZGF0YXNldCwgYWxzbyBidWlsZCBpdHMgZG93bmxvYWQvIGJ1bmRsZSAiDQogICAgICAgICAgICAg
#0#ICAgICAgICAgICAgICAgICIod2ViIGFyY2hpdmUsIG9yaWdpbmFsIC5pbXMsIE9NRS1USUZGLCBw
#0#ZXItY2hhbm5lbCBNSVAsIFJFQURNRSkuIikNCiAgICBhcmdzID0gcGFyc2VyLnBhcnNlX2FyZ3Mo
#0#KQ0KDQogICAgaW5wdXRfZGlyID0gUGF0aChhcmdzLmlucHV0KQ0KICAgIG91dHB1dF9kaXIgPSBQ
#0#YXRoKGFyZ3Mub3V0cHV0KQ0KDQogICAgaWYgbm90IGlucHV0X2Rpci5pc19kaXIoKToNCiAgICAg
#0#ICAgc3lzLmV4aXQoZiJbRkFUQUxdIElucHV0IGRpcmVjdG9yeSBub3QgZm91bmQ6IHtpbnB1dF9k
#0#aXJ9IikNCiAgICAgICAgDQogICAgb3V0cHV0X2Rpci5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0
#0#X29rPVRydWUpDQoNCiAgICAjIEdsb2IgSU1TIGZpbGVzDQogICAgaW1zX2ZpbGVzID0gc29ydGVk
#0#KGlucHV0X2Rpci5nbG9iKCIqLmltcyIpKQ0KICAgIGlmIGFyZ3Mub25seToNCiAgICAgICAgaW1z
#0#X2ZpbGVzID0gW3AgZm9yIHAgaW4gaW1zX2ZpbGVzIGlmIGZubWF0Y2guZm5tYXRjaChwLm5hbWUs
#0#IGFyZ3Mub25seSldDQoNCiAgICBpZiBub3QgaW1zX2ZpbGVzOg0KICAgICAgICBwcmludChfd2Fy
#0#bihmIkF1Y3VuIGZpY2hpZXIgLmltcyBjb3JyZXNwb25kYW50IGRhbnMge2lucHV0X2Rpcn0iKSkN
#0#CiAgICAgICAgc3lzLmV4aXQoMCkNCg0KICAgIHByaW50KCkNCiAgICBwcmludChfaGRyKCIgIFBp
#0#cGVsaW5lIGRlIHByZXByb2Nlc3NpbmcgICIpICsgX2RpbShmInZ7X192ZXJzaW9uX199IikpDQog
#0#ICAgcHJpbnQoX2RpbShmIiAgc291cmNlICAgICAgOiB7aW5wdXRfZGlyfSIpKQ0KICAgIHByaW50
#0#KF9kaW0oZiIgIGRlc3RpbmF0aW9uIDoge291dHB1dF9kaXJ9IikpDQogICAgcHJpbnQoX2RpbShm
#0#IiAgZGF0YXNldHMgICAgOiB7bGVuKGltc19maWxlcyl9ICAgKGZpbHRyZToge2FyZ3Mub25seSBv
#0#ciAnKid9KSIpKQ0KICAgIHByaW50KF9kaW0oZiIgIGRvd25sb2FkLyAgIDogeydvdWknIGlmIGFy
#0#Z3Mud2l0aF9kb3dubG9hZHMgZWxzZSAnbm9uJ30iKSkNCg0KICAgICMgR3JhY2VmdWwgQ3RybCtD
#0#OiBjb25maXJtIHdpdGggdGhlIHVzZXIsIHRoZW4gdGVhciB0aGUgcnVubmluZyBzdGVwIGRvd24g
#0#Y2xlYW5seS4NCiAgICBfaW5zdGFsbF9zaWdpbnRfaGFuZGxlcigpDQoNCiAgICAjIE9uZSBkYXRh
#0#c2V0IGF0IGEgdGltZSAoYm91bmRlZCBSQU0pIOKAlCBlYWNoIHN0ZXAgYWxyZWFkeSBtdWx0aXRo
#0#cmVhZHMgaW50ZXJuYWxseS4NCiAgICBpbnRlcnJ1cHRlZCA9IEZhbHNlDQogICAgZm9yIGksIGlt
#0#c19maWxlIGluIGVudW1lcmF0ZShpbXNfZmlsZXMpOg0KICAgICAgICB0cnk6DQogICAgICAgICAg
#0#ICBwcm9jZXNzX2ltc19maWxlKGltc19maWxlLCBvdXRwdXRfZGlyLCBpICsgMSwgbGVuKGltc19m
#0#aWxlcyksDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGhfZG93bmxvYWRzPWFyZ3Mu
#0#d2l0aF9kb3dubG9hZHMpDQogICAgICAgIGV4Y2VwdCBLZXlib2FyZEludGVycnVwdDoNCiAgICAg
#0#ICAgICAgIGludGVycnVwdGVkID0gVHJ1ZQ0KICAgICAgICAgICAgYnJlYWsNCiAgICAgICAgZXhj
#0#ZXB0IEV4Y2VwdGlvbiBhcyBleGM6DQogICAgICAgICAgICBwcmludChfZXJyKGYiICAgW1hdIHtp
#0#bXNfZmlsZS5uYW1lfSA6IHtleGN9IikpDQoNCiAgICBpZiBpbnRlcnJ1cHRlZDoNCiAgICAgICAg
#0#IyBSZW1vdmUgYW55IGhhbGYtd3JpdHRlbiB0ZW1wIGZvbGRlciBsZWZ0IGJ5IHRoZSBhYm9ydGVk
#0#IGRhdGFzZXQuDQogICAgICAgIGZvciBzdHJheSBpbiBvdXRwdXRfZGlyLmdsb2IoIi50ZW1wX3By
#0#ZXByb2Nlc3NfKiIpOg0KICAgICAgICAgICAgc2h1dGlsLnJtdHJlZShzdHJheSwgaWdub3JlX2Vy
#0#cm9ycz1UcnVlKQ0KICAgICAgICBwcmludCgpDQogICAgICAgIHByaW50KF93YXJuKCIgIFBpcGVs
#0#aW5lIGludGVycm9tcHUgcGFyIGwndXRpbGlzYXRldXIgKEN0cmwrQykuIEV0YXQgbmV0dG95ZS4i
#0#KSkNCiAgICAgICAgc3lzLmV4aXQoMTMwKQ0KDQogICAgcHJpbnQoKQ0KICAgIHByaW50KF9vaygi
#0#ICBQaXBlbGluZSB0ZXJtaW5lLiIpKQ0KDQppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOg0KICAg
#0#IHRyeToNCiAgICAgICAgbWFpbigpDQogICAgZXhjZXB0IEtleWJvYXJkSW50ZXJydXB0Og0KICAg
#0#ICAgICAjIEN0cmwrQyBjb25maXJtZWQgb3V0c2lkZSBhIGRhdGFzZXQgKGUuZy4gYmV0d2VlbiBz
#0#dGVwcykg4oCUIGV4aXQgY2xlYW5seS4NCiAgICAgICAgcHJpbnQoX3dhcm4oIlxuWyFdIFBpcGVs
#0#aW5lIGFycmV0ZS4iKSwgZmlsZT1zeXMuc3RkZXJyKQ0KICAgICAgICBzeXMuZXhpdCgxMzApDQo=
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
