@echo off
setlocal
set "RUNTIME_CONFIG=%~dp0..\config\cutflow-runtime.json"
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -Command "$r=Get-Content -LiteralPath '%RUNTIME_CONFIG%' -Raw | ConvertFrom-Json; $r.pythonExecutable"`) do set "TEMPORAL_PYTHON=%%P"
if not defined TEMPORAL_PYTHON (
  echo RUNTIME_DEPENDENCY_UNAVAILABLE: pythonExecutable is missing from the Cutflow Runtime Contract 1>&2
  exit /b 2
)
if not exist "%TEMPORAL_PYTHON%" (
  echo RUNTIME_DEPENDENCY_UNAVAILABLE: configured Python executable does not exist 1>&2
  exit /b 2
)
"%TEMPORAL_PYTHON%" "%~dp0..\worker\temporal-artifact-analyzer.py" %*
exit /b %ERRORLEVEL%
