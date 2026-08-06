@echo off
setlocal
set CODEX_HOME=D:\codex\.codex
set XDG_CACHE_HOME=D:\codex\cache
set TEMP=D:\codex\tmp
set TMP=D:\codex\tmp
set TMPDIR=D:\codex\tmp
set ALLOWED_NAS_ROOTS=\\192.168.120.60\创意部-广告投放;\\192.168.120.60\新广告投放
set FFMPEG_PATH=D:\JianyingPro\11.1.0.14287\ffmpeg.exe
set GOLD_STANDARD_PATH=D:\自动剪辑网站\standards\reference-sets\gc-good-20260805\gold-standard-v2.json
set TEXT_LAYOUT_STANDARD=D:\自动剪辑网站\standards\text-layout-9x16-v1.json
set BGM_LIBRARY_PATH=E:\尔尔本地\素材\基督\自动剪辑\bgm
set PYTHONPATH=D:\codex\cache\pydeps
set PYTHON_PATH=D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v CUTFLOW_DELIVERY_OUTPUT_DIR 2^>nul ^| findstr /i CUTFLOW_DELIVERY_OUTPUT_DIR') do set DELIVERY_OUTPUT_DIR=%%b

cd /d "D:\自动剪辑网站"

start /B "cutflow-web" "D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "node_modules\next\dist\bin\next" "start" "-p" "3001" > "D:\自动剪辑网站\logs\web.stdout.log" 2> "D:\自动剪辑网站\logs\web.stderr.log"
start /B "cutflow-worker" "D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "worker\processor.mjs" > "D:\自动剪辑网站\logs\worker.stdout.log" 2> "D:\自动剪辑网站\logs\worker.stderr.log"
start /B "cutflow-template" "D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "worker\template-processor.mjs" > "D:\自动剪辑网站\logs\template.stdout.log" 2> "D:\自动剪辑网站\logs\template.stderr.log"
start /B "cutflow-delivery" "D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "worker\delivery-watcher.mjs" > "D:\自动剪辑网站\logs\delivery.stdout.log" 2> "D:\自动剪辑网站\logs\delivery.stderr.log"
start /B "cutflow-chatcut" "D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "worker\chatcut-sync.mjs" > "D:\自动剪辑网站\logs\chatcut.stdout.log" 2> "D:\自动剪辑网站\logs\chatcut.stderr.log"

echo all 5 processes started
endlocal
