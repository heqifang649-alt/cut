@echo off
setlocal
rem CUT_WORK_ROOT 由 .env.local 唯一定义（start-cutflow.ps1 负责解析）。
rem 这里不再硬编码，避免与 Web 端 Next.js 读到的值分叉。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-cutflow.ps1" -NoBrowser
set EXIT_CODE=%ERRORLEVEL%
endlocal & exit /b %EXIT_CODE%
