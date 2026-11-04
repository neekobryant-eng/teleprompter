@echo off
rem Starts the teleprompter dev server and links the tablet over USB.
rem Double-click this file, or run "dev.cmd" in a terminal in this folder.

cd /d "%~dp0"

set "ADB=%USERPROFILE%\Downloads\platform-tools-latest-windows\platform-tools\adb.exe"
if not exist "%ADB%" set "ADB=adb"

echo Linking the tablet: adb reverse tcp:8080 tcp:8080
"%ADB%" reverse tcp:8080 tcp:8080
if errorlevel 1 (
  echo.
  echo   Tablet not linked. Plug it in over USB, unlock it, accept any
  echo   "Allow USB debugging" prompt, then run this file again.
  echo   The server still starts, so you can test on this laptop.
) else (
  echo   Tablet linked. On the tablet, open Chrome to http://localhost:8080
)
echo.

node server.mjs
pause
