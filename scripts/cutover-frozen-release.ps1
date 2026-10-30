$ErrorActionPreference = 'Stop'
$sourceRoot = 'D:\自动剪辑网站'
$releaseRoot = 'D:\CUT-Releases\20261022-stability-r1'
$rollbackRoot = 'D:\CUT-Releases\20261022-original-r0'
$evidenceRoot = 'D:\CUT-Releases\maintenance-20261022'
if (Test-Path -LiteralPath (Join-Path $evidenceRoot 'CUTOVER-RESULT.json')) {
  throw 'This maintenance window has already consumed its single production cutover attempt. Do not rerun; obtain a new maintenance authorization.'
}
$taskNames = @('Cutflow Morning Website', 'Cutflow Worker Startup')
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$nodeExe = (Get-Content -Raw -LiteralPath (Join-Path $releaseRoot 'config\cutflow-runtime.json') | ConvertFrom-Json).nodeExecutable
$changedTasks = $false
$stopped = $false
$outcome = [ordered]@{ startedAt = [DateTimeOffset]::UtcNow.ToString('o'); release = $releaseRoot; rollback = $rollbackRoot; switched = $false; rolledBack = $false }

function Assert-IdleProduction {
  $queue = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'data\service-queue.json') | ConvertFrom-Json
  $active = @($queue.tasks | Where-Object { $_.status -in @('running','leased','processing') -or ($_.leaseExpiresAt -and [DateTimeOffset]::Parse($_.leaseExpiresAt) -gt [DateTimeOffset]::UtcNow) })
  if ($active.Count) { throw "Active leases/tasks: $($active.Count)" }
  $batches = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'data\batches.json') | ConvertFrom-Json
  $running = @($batches | Where-Object { $_.status -in @('editing','revising','analyzing_reference','creating_proxies','detecting_products','cancel_requested') })
  if ($running.Count) { throw "Active batch states: $($running.Count)" }
  $locks = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'data') -File -Filter '*.lock')
  if ($locks.Count) { throw "Data locks still present: $($locks.Name -join ',')" }
}
function Set-TaskRoot([string]$root) {
  foreach ($name in $taskNames) {
    $arguments = '//B //Nologo "' + (Join-Path $root 'scripts\ensure-cutflow-hidden.vbs') + '"'
    if ($name -eq 'Cutflow Morning Website') { $arguments += ' -OpenBrowser' }
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $root
    Set-ScheduledTask -TaskName $name -Action $action | Out-Null
  }
}
function Stop-RootProcesses([string]$root) {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($root + '\') })
  # Stop Web first so its availability watchdog cannot recreate Fleet.
  foreach ($p in @($processes | Where-Object { $_.CommandLine -match 'next.*start|run-cut-web\.mjs' })) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
  foreach ($p in @($processes | Where-Object { $_.CommandLine -match 'fleet-supervisor\.mjs' })) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
  $remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($root + '\') })
  foreach ($p in $remaining) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
}
function Start-Root([string]$root) {
  & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-cutflow.ps1') -NoBrowser -SkipAccountCheck
  if ($LASTEXITCODE -ne 0) { throw "Startup failed for $root (exit $LASTEXITCODE)" }
  $web = Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 10
  if ($web.StatusCode -ne 200) { throw 'Web HTTP gate failed' }
}
try {
  & (Join-Path $releaseRoot 'scripts\assert-frozen-release.ps1')
  $validation = Get-ChildItem -LiteralPath 'D:\CUT-Releases' -Directory | Where-Object {$_.Name -like '20261022-stability-r1-validation-*'} | Sort-Object Name -Descending | Select-Object -First 1
  $rollbackValidation = Get-ChildItem -LiteralPath 'D:\CUT-Releases' -Directory | Where-Object {$_.Name -like '20261022-original-r0-validation-*'} | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $validation -or -not (Get-Content -Raw -LiteralPath (Join-Path $validation.FullName 'VALIDATION-RESULT.json') | ConvertFrom-Json).pass) { throw 'Release independent validation missing' }
  if (-not $rollbackValidation -or -not (Get-Content -Raw -LiteralPath (Join-Path $rollbackValidation.FullName 'VALIDATION-RESULT.json') | ConvertFrom-Json).pass) { throw 'Rollback independent validation missing' }
  Assert-IdleProduction
  & $nodeExe (Join-Path $sourceRoot 'scripts\record-stability-state.mjs') (Join-Path $evidenceRoot 'before-cutover.json')
  if ($LASTEXITCODE -ne 0) { throw 'State snapshot failed' }
  $outcome.processesBefore = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($sourceRoot + '\') } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)
  $changedTasks = $true
  foreach ($name in $taskNames) { Disable-ScheduledTask -TaskName $name | Out-Null }
  $taskDeadline = (Get-Date).AddSeconds(15)
  do {
    $runningLaunchers = @(Get-ScheduledTask -TaskName $taskNames | Where-Object { $_.State -eq 'Running' })
    if (-not $runningLaunchers.Count) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $taskDeadline)
  if ($runningLaunchers.Count) { throw 'An existing startup task is still running' }
  Assert-IdleProduction
  Set-TaskRoot $releaseRoot
  $stopped = $true
  Stop-RootProcesses $sourceRoot
  if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { throw '3001 still occupied after stop' }
  $archiveRoot = 'E:\CUT-LogArchive\20261022'
  New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
  $oldLog = 'E:\cutflow批量\worker-scratch\logs\fleet-supervisor.log'
  if (Test-Path -LiteralPath $oldLog) {
    $archiveFile = Join-Path $archiveRoot ('fleet-supervisor-before-freeze-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.log')
    if (-not [IO.Path]::GetFullPath($archiveFile).StartsWith($archiveRoot + '\')) { throw 'Archive path boundary rejected' }
    Move-Item -LiteralPath $oldLog -Destination $archiveFile
    $outcome.originalLogArchive = $archiveFile
    $outcome.originalLogBytes = (Get-Item -LiteralPath $archiveFile).Length
  }
  Start-Root $releaseRoot
  $outcome.switched = $true
} catch {
  $outcome.error = $_.Exception.Message
  if ($stopped) {
    Stop-RootProcesses $releaseRoot
    Set-TaskRoot $rollbackRoot
    try { Start-Root $rollbackRoot; $outcome.rolledBack = $true }
    catch { $outcome.rollbackError = $_.Exception.Message }
  } elseif ($changedTasks) { Set-TaskRoot $sourceRoot }
} finally {
  if ($changedTasks) { foreach ($name in $taskNames) { Enable-ScheduledTask -TaskName $name | Out-Null } }
  $outcome.endedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $outcome | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'CUTOVER-RESULT.json') -Encoding UTF8
}
[pscustomobject]$outcome | Select-Object startedAt,endedAt,switched,rolledBack,error,rollbackError,originalLogArchive,originalLogBytes | ConvertTo-Json -Compress
if (-not $outcome.switched) { exit 1 }
