@echo off
rem ---------------------------------------------------------------------------
rem Starts the preview server with the latest codebase.
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



echo Starting preview server...
call npm run preview
if errorlevel 1 (
  echo ERROR: preview failed.
  exit /b 1
)

echo.
echo Preview exited.

exit /b 0
