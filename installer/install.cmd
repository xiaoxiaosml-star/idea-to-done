@echo off
chcp 65001 >nul
title 成事工坊 安装器
where node >nul 2>nul
if errorlevel 1 (
  echo [安装器] 未找到 Node.js。请先安装 Node.js LTS ^(https://nodejs.org^) 或使用含运行时的安装包。
  pause
  exit /b 1
)
node "%~dp0install.js" %*
if errorlevel 1 (
  echo.
  echo 安装未完成,请按上面提示处理后重新运行本安装器。
  pause
)
