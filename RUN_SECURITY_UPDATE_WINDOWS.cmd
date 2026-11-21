@echo off
setlocal
cd /d "%~dp0"
echo === milgyo-system: dependency security update ===
echo IMPORTANT: this is the existing milgyo-system project root, NOT the official homepage project.
echo The administrative test-data reset feature and D1/R2 are not modified.
if not exist package.json goto wrong_folder
if not exist scripts\security\upgrade-dependencies.mjs goto wrong_folder
node --version
if errorlevel 1 goto failure
npm --version
if errorlevel 1 goto failure
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]!==24 || v[1]<22 || (v[1]===22 && v[2]<3)){console.error('Required: Node.js 24.22.3 or newer 24.x security update. Found: '+process.version);process.exit(1)}"
if errorlevel 1 goto failure
call npm run security:upgrade
if errorlevel 1 goto failure
echo.
echo SUCCESS. Review package-lock.json, then commit updated files for a protected Preview deployment.
pause
exit /b 0
:wrong_folder
echo ERROR: Copy this file into the milgyo-system repository root next to package.json.
pause
exit /b 1
:failure
echo.
echo ERROR: Update did not finish. Do NOT push until the error is resolved.
pause
exit /b 1
