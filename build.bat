@echo off
rem ---------------------------------------------------------------------------
rem Builds the player into docs\ - the single-file bundle that GitHub Pages
rem serves and that also runs when index.html is double-clicked.
rem
rem Double-click this file, or run it from a terminal. Pass "nopause" to skip
rem the "press any key" at the end (useful from scripts / CI).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found on PATH. Install Node.js from https://nodejs.org/
  if /i not "%~1"=="nopause" pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    if /i not "%~1"=="nopause" pause
    exit /b 1
  )
)

echo Building...
call npm run build
if errorlevel 1 (
  echo ERROR: build failed.
  if /i not "%~1"=="nopause" pause
  exit /b 1
)

echo.
echo Build complete: "%CD%\docs\index.html"
if /i not "%~1"=="nopause" pause
exit /b 0
