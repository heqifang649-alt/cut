$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $portalRoot 'data'

$heartbeatFiles = @(
  'worker-heartbeat.json',
  'template-worker-heartbeat.json',
  'delivery-worker-heartbeat.json',
  'chatcut-worker-heartbeat.json'
)

foreach ($name in $heartbeatFiles) {
  $heartbeatPath = Join-Path $dataRoot $name
  if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) { continue }
  try {
    $record = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -match 'worker\\(processor|template-processor|delivery-watcher|chatcut-sync)\.mjs') {
      Stop-Process -Id $record.pid -Force
    }
  } catch {}
}

$listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($webProcess -and $webProcess.Name -eq 'node.exe' -and $webProcess.CommandLine -like '*next*start*-p*3001*') {
    Stop-Process -Id $listener.OwningProcess -Force
  }
}

# All store writers are stopped at this point. Recover abandoned lock files by
# renaming them instead of deleting them, so restart cannot hang behind a
# filesystem delete guard and queued work can resume immediately.
Get-ChildItem -LiteralPath $dataRoot -Filter '*.lock' -File -ErrorAction SilentlyContinue | ForEach-Object {
  $recovered = "$($_.FullName).recovered.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).$([guid]::NewGuid().ToString('N'))"
  Move-Item -LiteralPath $_.FullName -Destination $recovered
}

Start-Sleep -Milliseconds 700
& (Join-Path $PSScriptRoot 'start-cutflow.ps1') -NoBrowser
