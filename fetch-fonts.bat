@echo off
cd /d "%~dp0"
echo Downloading the MKUYU fonts...
node tools\fetch_fonts.mjs
pause
