@echo off
title Ollama Chat Server
setlocal EnableDelayedExpansion

:: Always run from the folder where this bat file lives
cd /d "%~dp0"

echo ================================
echo   Ollama Chat - Local Server
echo ================================
echo.

:: ── SET YOUR MODEL NAME HERE ─────────────────────────────────────────────────
:: Run "ollama list" to see available models. Copy the exact NAME value.
set OLLAMA_MODEL=gpt-oss:120b-cloud
:: ─────────────────────────────────────────────────────────────────────────────

set PORT=3000
set OLLAMA_HOST=http://localhost:11434

:: Auth token shared between server and browser UI (required — server refuses to start without it)
if not exist "%~dp0.app_token" (
    powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0.app_token', [guid]::NewGuid().ToString('N'))"
)
set /p APP_TOKEN=<"%~dp0.app_token"
echo App token: %APP_TOKEN%
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)

:: Install dependencies only if node_modules is missing
if not exist "%~dp0node_modules\" (
    echo Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. See error above.
        pause & exit /b 1
    )
    echo.
) else (
    echo Dependencies OK. Skipping npm install.
    echo.
)

:: Show access URLs
echo Access URLs:
for /f "tokens=*" %%a in ('powershell -Command "(Get-NetIPAddress -InterfaceAlias '*Tailscale*' -AddressFamily IPv4 2>$null).IPAddress"') do (
    echo   Phone  ^(Tailscale^): http://%%a:%PORT%/?token=%APP_TOKEN%
)
echo   Browser ^(this PC^):  http://localhost:%PORT%/?token=%APP_TOKEN%
echo.
echo.
echo Model: %OLLAMA_MODEL%
echo Starting server... Press Ctrl+C to stop.
echo.

node server.js

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server stopped with error code %errorlevel%
    pause
)
