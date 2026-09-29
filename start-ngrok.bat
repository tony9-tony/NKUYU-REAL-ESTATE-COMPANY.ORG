@echo off
title MKUYU public link (ngrok)
rem Shares http://localhost:3003 (this project) - start start-mkuyu.bat first.
ngrok http 3003
if errorlevel 1 echo ngrok is not installed or not signed in. Install it from https://ngrok.com/download
pause
