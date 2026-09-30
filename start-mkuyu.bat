@echo off
title MKUYU server (keep this window open)
cd /d "%~dp0"
rem Stop an older MKUYU server still holding port 3003, so the new code loads.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3003 " ^| findstr LISTENING') do (
  echo Stopping old server, PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul
npm run dev
pause
