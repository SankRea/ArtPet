@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.12.0 or newer with npm, then try again.
  pause
  exit /b 1
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12.0 or newer is required. Please upgrade Node.js.
  pause
  exit /b 1
)

call :check_dependencies >nul 2>nul
if not errorlevel 1 goto launch

echo Dependencies are missing or incomplete. Installing them now...
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please reinstall Node.js with npm, then try again.
  pause
  exit /b 1
)
set "ELECTRON_SKIP_BINARY_DOWNLOAD="
if exist "package-lock.json" (
  call npm.cmd ci --include=dev --include=optional --ignore-scripts=false --no-audit --no-fund
) else (
  call npm.cmd install --include=dev --include=optional --ignore-scripts=false --no-audit --no-fund
)
if errorlevel 1 (
  echo Dependency installation failed. Check the npm error above and your network or proxy settings, then run this script again.
  pause
  exit /b 1
)
call :check_dependencies
if errorlevel 1 (
  echo Dependencies are still incomplete. Check the error above before trying again.
  pause
  exit /b 1
)

:launch
start "" "node_modules\electron\dist\electron.exe" "." %*
if errorlevel 1 (
  echo Failed to start ArkPet.
  pause
  exit /b 1
)
exit /b 0

:check_dependencies
node -e "const fs = require('node:fs'); for (const file of ['node_modules/electron/dist/electron.exe', 'node_modules/pixi.js/dist/pixi.min.js', 'node_modules/pixi-spine/dist/pixi-spine.js', require('electron')]) fs.accessSync(file); require('koffi');"
exit /b %errorlevel%
