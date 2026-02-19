@echo off
setlocal
set "ROOT=%~dp0"
set "NODE_EXE="
set "NPM_CLI="

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\PROGRA~1\nodejs\node.exe" set "NODE_EXE=C:\PROGRA~1\nodejs\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"

if exist "%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js" set "NPM_CLI=%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js"
if not defined NPM_CLI if exist "C:\PROGRA~1\nodejs\node_modules\npm\bin\npm-cli.js" set "NPM_CLI=C:\PROGRA~1\nodejs\node_modules\npm\bin\npm-cli.js"
if not defined NPM_CLI if exist "%APPDATA%\npm\node_modules\npm\bin\npm-cli.js" set "NPM_CLI=%APPDATA%\npm\node_modules\npm\bin\npm-cli.js"

if not defined NODE_EXE (
  echo Node was not found. Install Node.js 20+ and try again.
  exit /b 1
)

if not defined NPM_CLI (
  echo npm-cli.js was not found. Reinstall Node.js or npm and try again.
  exit /b 1
)

cd /d "%ROOT%"
"%NODE_EXE%" "%NPM_CLI%" install || exit /b 1
"%NODE_EXE%" "%NPM_CLI%" run build:msi
