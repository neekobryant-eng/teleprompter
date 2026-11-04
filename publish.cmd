@echo off
rem Publishes the app to GitHub Pages: commits every change in this folder and pushes it.
rem Double-click this file. The site updates about a minute later.

cd /d "%~dp0"

set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not exist "%GIT%" set "GIT=git"

"%GIT%" add -A
"%GIT%" diff --cached --quiet
if not errorlevel 1 (
  echo No changes since the last commit.
  goto push
)

echo Changes to publish:
"%GIT%" status --short
echo.
set "MSG="
set /p "MSG=Describe the change, or press Enter to skip: "
if not defined MSG set "MSG=Update"
"%GIT%" commit -q -m "%MSG%"
if errorlevel 1 goto failed

:push
"%GIT%" push -q
if errorlevel 1 goto failed
echo.
echo Published. https://neekobryant-eng.github.io/teleprompter/ updates in about a minute.
echo The tablet picks it up the next time the app opens online.
goto end

:failed
echo.
echo Publishing failed; see the message above.

:end
echo.
pause
