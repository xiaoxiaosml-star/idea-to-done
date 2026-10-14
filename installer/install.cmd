@echo off
chcp 65001 >nul
title 成事工坊 安装器

where node >nul 2>nul
if not errorlevel 1 goto RUN

echo [安装器] 未找到 Node.js，正在为成事工坊准备专用运行时（约 30MB，一次性下载）...
if not exist "%~dp0runtime\node\node.exe" (
  %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $base='https://registry.npmmirror.com/-/binary/node/latest-v24.x/'; $wc=New-Object System.Net.WebClient; $sums=$wc.DownloadString($base+'SHASUMS256.txt'); $line=([regex]::Match($sums,'(?m)^[0-9a-f]{64}\s+node-v[0-9.]+-win-x64\.zip\r?$')).Value; if(-not $line){throw '校验清单里找不到win-x64包'}; $want=($line -split '\s+')[0]; $zip=($line -split '\s+')[1]; $dl=\"$env:TEMP\chengshi-node.zip\"; if(Test-Path $dl){Remove-Item $dl -Force}; $wc.DownloadFile($base+$zip,$dl); $got=(Get-FileHash $dl -Algorithm SHA256).Hash.ToLower(); if($got -ne $want){Remove-Item $dl -Force; throw '下载校验失败(哈希不符),已删除,请重试'}; Expand-Archive $dl -DestinationPath \"%~dp0runtime\" -Force; Remove-Item $dl -Force; Get-ChildItem \"%~dp0runtime\node-v*-win-x64\" | Rename-Item -NewName 'node' -ErrorAction SilentlyContinue; if(-not (Test-Path \"%~dp0runtime\node\node.exe\")){ Get-ChildItem \"%~dp0runtime\" -Directory -Filter 'node-v*-win-x64' | ForEach-Object { Rename-Item $_.FullName 'node' } }" >"%TEMP%\chengshi-node-dl.log" 2>&1
  if errorlevel 1 (
    echo [安装器] 专用运行时下载/校验失败，原因如下：
    type "%TEMP%\chengshi-node-dl.log"
    echo [安装器] 请检查网络后重试，或手动安装 Node.js LTS。
    pause
    exit /b 1
  )
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
