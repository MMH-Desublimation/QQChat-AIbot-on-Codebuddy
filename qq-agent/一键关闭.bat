@echo off
chcp 65001 >nul
title qq-agent shutdown

echo ============================================================
echo  qq-agent shutdown
echo ============================================================
echo.

echo [1/3] Stopping chat process (src\index.js)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'qq-agent' -and $_.CommandLine -match 'index\.js' }; if($p){ $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('  stopped pid ' + $_.ProcessId) } } else { Write-Host '  not running' }"

echo [2/3] Stopping console (ui\server.js)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'qq-agent' -and $_.CommandLine -match 'ui' -and $_.CommandLine -match 'server\.js' }; if($p){ $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('  stopped pid ' + $_.ProcessId) } } else { Write-Host '  not running' }"

echo [3/3] Stopping NapCat / QQ
taskkill /f /im NapCatWinBootMain.exe >nul 2>&1
if errorlevel 1 (echo   NapCat not running) else (echo   NapCat stopped)
taskkill /f /im QQ.exe >nul 2>&1
if errorlevel 1 (echo   QQ not running) else (echo   QQ stopped)

echo.
echo ============================================================
echo  All stopped.
echo ============================================================
timeout /t 3 /nobreak >nul
