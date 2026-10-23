@echo off
cd /d "%~dp0"
chcp 65001 >nul
title qq-agent launcher

rem ── 找 Node.js（22+，需要内置 fetch / WebSocket）──────────────────
set "NODE_DIR="
where node >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%i in ('where node') do (
        set "NODE_DIR=%%~dpi"
        goto :node_ready
    )
)
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\find-node.ps1"`) do set "NODE_DIR=%%i"

:node_ready
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [!] 没找到 node.exe
    echo     请安装 Node.js 22 或更高版本：https://nodejs.org/
    echo     装好后重新双击本文件。
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo        Node %%v

rem 端口探测用小超时：Test-NetConnection 在端口关闭时要等 20 秒以上，界面会像卡死
set PROBE=powershell -NoProfile -ExecutionPolicy Bypass -Command "function P($p){ $c=New-Object Net.Sockets.TcpClient; try{ return ($c.ConnectAsync('127.0.0.1',$p).Wait(400) -and $c.Connected) } catch { return $false } finally { $c.Close() } }; if((P 3001) -and (P 3000)){ exit 0 } else { exit 1 }"

echo ============================================================
echo  qq-agent one-click start
echo ============================================================
echo.

echo [1/3] NapCat (OneBot ports 3000/3001)
%PROBE%
if errorlevel 1 (
    echo       NapCat not ready, launching it...
    start "" "%~dp0..\napcat\启动NapCat.bat"
    echo       Waiting up to 60s for port 3001 ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "function P($p){ $c=New-Object Net.Sockets.TcpClient; try{ return ($c.ConnectAsync('127.0.0.1',$p).Wait(400) -and $c.Connected) } catch { return $false } finally { $c.Close() } }; for($i=0;$i -lt 60;$i++){ if(P 3001){ exit 0 }; Start-Sleep -Seconds 1 }; exit 1"
    if errorlevel 1 echo       [!] Port 3001 still closed - if QQ shows a login page, scan the QR code first, then run this again.
) else (
    echo       Already running.
)

echo.
echo [2/3] Console (GUI on 127.0.0.1:3100)
powershell -NoProfile -ExecutionPolicy Bypass -Command "function P($p){ $c=New-Object Net.Sockets.TcpClient; try{ return ($c.ConnectAsync('127.0.0.1',$p).Wait(400) -and $c.Connected) } catch { return $false } finally { $c.Close() } }; if(P 3100){ exit 0 } else { Start-Process -FilePath 'node' -ArgumentList 'src/ui/server.js' -WorkingDirectory '%~dp0' -WindowStyle Minimized; exit 1 }"
if errorlevel 1 (
    echo       Waiting for console ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "function P($p){ $c=New-Object Net.Sockets.TcpClient; try{ return ($c.ConnectAsync('127.0.0.1',$p).Wait(400) -and $c.Connected) } catch { return $false } finally { $c.Close() } }; for($i=0;$i -lt 30;$i++){ if(P 3100){ exit 0 }; Start-Sleep -Milliseconds 400 }; exit 1"
) else (
    echo       Already running.
)

echo.
echo [3/3] Opening browser
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~dp0data\ui-token'; if(Test-Path $f){ $t=(Get-Content $f -Raw).Trim(); Start-Process ('http://127.0.0.1:3100/?token='+$t) } else { Write-Host '  [!] data\ui-token missing' }"

echo.
echo ============================================================
echo  Ready. Console page should be open in your browser.
echo  Chat process auto-starts; use [Stop] in the UI.
echo ============================================================
timeout /t 4 /nobreak >nul
