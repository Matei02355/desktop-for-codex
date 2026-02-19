@echo off
setlocal
set "ROOT=%~dp0"
set "ELECTRON_CLI=%ROOT%node_modules\electron\cli.js"
set "NODE_EXE="

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\PROGRA~1\nodejs\node.exe" set "NODE_EXE=C:\PROGRA~1\nodejs\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  echo Node was not found. Install Node.js 20+ and try again.
  exit /b 1
)

if not exist "%ELECTRON_CLI%" (
  echo Electron is not installed. Run build-exe.cmd or install dependencies first.
  exit /b 1
)

"%NODE_EXE%" "%ELECTRON_CLI%" "%ROOT%"
