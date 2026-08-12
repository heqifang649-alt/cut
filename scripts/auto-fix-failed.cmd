@echo off
chcp 65001 >nul
setlocal

title GC Cutflow — 一键检测修复
cd /d "D:\自动剪辑网站"

echo ============================================================
echo   GC Cutflow Auto Fix — 一键检测修复所有 failed 批次
echo ============================================================
echo.

:: Use the managed Python runtime
set "PYTHON_EXE=C:\Users\尔尔\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PYTHON_EXE%" (
  echo ERROR: managed Python not found at %PYTHON_EXE%
  pause
  exit /b 1
)

:: Pre-flight: make sure cutflow web is up
curl -s -o nul -w "" http://127.0.0.1:3001/api/health 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [WARN] GC Cutflow web 未运行 ^(http://127.0.0.1:3001 无响应^)
  echo        请先双击 scripts\start-cutflow.cmd 启动服务
  echo.
  pause
  exit /b 1
)

echo [1/3] 扫描 failed 批次...
"%PYTHON_EXE%" "%~dp0auto_fix_failed.py" --dry-run
echo.

echo [2/3] 应用修复...
"%PYTHON_EXE%" "%~dp0auto_fix_failed.py"
echo.

echo [3/3] 验证服务状态...
"%PYTHON_EXE%" -c "import json,urllib.request; r=json.loads(urllib.request.urlopen('http://127.0.0.1:3001/api/health',timeout=3).read()); print('  workerOnline:', r.get('workerOnline')); print('  codex.ready :', r.get('codex',{}).get('ready')); print('  chatcut.ready:', r.get('chatcut',{}).get('ready'))"
echo.

echo ============================================================
echo   修复完成。刷新 http://192.168.30.38:3001 查看结果。
echo ============================================================
echo.
pause
endlocal
