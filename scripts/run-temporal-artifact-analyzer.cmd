@echo off
setlocal
if "%PYTHON_PATH%"=="" (
  set "TEMPORAL_PYTHON=python"
) else (
  set "TEMPORAL_PYTHON=%PYTHON_PATH%"
)
if not "%TEMPORAL_ANALYZER_PYTHONPATH%"=="" set "PYTHONPATH=%TEMPORAL_ANALYZER_PYTHONPATH%;%PYTHONPATH%"
"%TEMPORAL_PYTHON%" "%~dp0..\worker\temporal-artifact-analyzer.py" %*
set "TEMPORAL_EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %TEMPORAL_EXITCODE%
