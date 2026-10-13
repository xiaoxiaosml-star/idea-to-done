@echo off
chcp 65001 >nul
title 成事工坊 安装器

where node >nul 2>nul
if not errorlevel 1 goto RUN

echo [安装器] 未找到 Node.js，正在为成事工坊准备专用运行时（约 30MB，一次性下载）...
if not exist "%~dp0runtime\node\node.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $base='https://registry.npmmirror.com/-/binary/node/latest-v24.x/'; $idx=Invoke-RestMethod $base; $zip=($idx | Where-Object { $_.name -like '*-win-x64.zip' } | Select-Object -First 1).name; if(-not $zip){throw '未找到win-x64包'}; Invoke-WebRequest ($base+$zip) -OutFile \"$env:TEMP\chengshi-node.zip\"; Expand-Archive \"$env:TEMP\chengshi-node.zip\" -DestinationPath \"%~dp0runtime\" -Force; Get-ChildItem \"%~dp0runtime\node-v*-win-x64\" | Rename-Item -NewName 'node' -ErrorAction SilentlyContinue; if(-not (Test-Path \"%~dp0runtime\node\node.exe\")){ Get-ChildItem \"%~dp0runtime\" -Directory -Filter 'node-v*-win-x64' | ForEach-Object { Rename-Item $_.FullName 'node' } }"
)
if not exist "%~dp0runtime\node\node.exe" (
  echo [安装器] 专用运行时准备失败。请检查网络后重试，或手动安装 Node.js LTS。
  pause
  exit /b 1
)
set "PATH=%~dp0runtime\node;%PATH%"
echo [安装器] 专用运行时就绪。

:RUN
node "%~dp0install.js" %*
if errorlevel 1 (
  echo.
  echo 安装未完成，请按上面提示处理后重新运行本安装器。
  pause
)
