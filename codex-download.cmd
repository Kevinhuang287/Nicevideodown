@echo off
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo {"ok":false,"error":"需要 PowerShell 7 才能运行 Codex 静默接口"}
  exit /b 9009
)
pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0codex-download.ps1" %*
