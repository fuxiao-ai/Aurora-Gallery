@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo [pack-win] Node:
node -v
if errorlevel 1 exit /b 1

echo [pack-win] Rebuild native modules for Electron...
call npm run rebuild-native
if errorlevel 1 exit /b 1

echo [pack-win] electron-builder Windows NSIS x64...
call npm run dist:win
if errorlevel 1 exit /b 1

echo [pack-win] Done. Output: release\
endlocal
exit /b 0
