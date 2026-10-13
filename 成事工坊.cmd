@echo off
chcp 65001 >nul
set ROOT=%~dp0
set NODE=node
if exist "%ROOT%installer\runtime\node\node.exe" set NODE="%ROOT%installer\runtime\node\node.exe"
"%NODE%" "%ROOT%runtime\launcher.js" %*
if errorlevel 1 pause
