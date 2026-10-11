@echo off
rem Builds Aurora as a normal Windows program and starts its installer.
rem Double-click this file. The first build takes several minutes.
title Building Aurora
cd /d "%~dp0"

where npm >nul 2>nul || (echo Node.js is missing. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
where cargo >nul 2>nul || (echo Rust is missing. Install it from https://rustup.rs and run this again. & pause & exit /b 1)

echo Installing packages...
call npm install || (pause & exit /b 1)

echo Building Aurora (this takes a while the first time)...
call npm run app:build || (echo. & echo The build failed, see the messages above. & pause & exit /b 1)

for %%f in ("src-tauri\target\release\bundle\nsis\*-setup.exe") do set "SETUP=%%~ff"
if not defined SETUP (echo Couldn't find the installer. & pause & exit /b 1)

echo.
echo Done: %SETUP%
echo Starting the installer...
start "" "%SETUP%"
