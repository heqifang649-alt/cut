param(
  [string]$oldRoot = 'D:\CUT-Releases\20261027-multisource-canary-r3',
  [string]$newRoot = 'D:\CUT-Releases\20261027-multisource-canary-r4'
)
$ErrorActionPreference = 'Stop'
$taskNames = @('Cutflow Morning Website', 'Cutflow Worker Startup')
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$result = [ordered]@{
  startedAt = [DateTimeOffset]::Now.ToString('o')
  rollbackTarget = $oldRoot
  release = $newRoot
  switched = $false
  rolledBack = $false
}
$tasksChanged = $false
$oldStopped = $false

function Set-TaskRoot([string]$root) {
  foreach ($name in $taskNames) {
    $arguments = '//B //Nologo "' + (Join-Path $root 'scripts\ensure-cutflow-hidden.vbs') + '"'
    if ($name -eq 'Cutflow Morning Website') { $arguments += ' -OpenBrowser' }
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $root
    Set-ScheduledTask -TaskName $name -Action $action | Out-Null
  }
}

function Stop-RootProcesses([string]$root) {
  $escaped = $root.Replace('/', '\') + '\'
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($escaped)
  } | Sort-Object { if ($_.Name -eq 'node.exe') { 0 } else { 1 } })
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Idle {
  $queue = Get-Content -LiteralPath (Join-Path $oldRoot 'data\service-queue.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $active = @($queue.tasks | Where-Object {
    $_.status -in @('running', 'leased', 'processing') -or
    ($_.leaseExpiresAt -and [DateTimeOffset]::Parse($_.leaseExpiresAt) -gt [DateTimeOffset]::UtcNow)
  })
  if ($active.Count) { throw "Active queue tasks or leases: $($active.Count)" }
  $batches = Get-Content -LiteralPath (Join-Path $oldRoot 'data\batches.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $running = @($batches | Where-Object {
    $_.status -in @('editing', 'revising', 'analyzing_reference', 'creating_proxies', 'detecting_products', 'cancel_requested')
  })
  if ($running.Count) { throw "Active batch states: $($running.Count)" }
}

function Start-Root([string]$root) {
  & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-cutflow.ps1') -NoBrowser -SkipAccountCheck
  if ($LASTEXITCODE -ne 0) { throw "Startup failed for $root (exit $LASTEXITCODE)" }
  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return }
    } catch {}
  } while ((Get-Date) -lt $deadline)
  throw "Web health timeout for $root"
}

try {
  Assert-Idle
  foreach ($name in $taskNames) {
    Disable-ScheduledTask -TaskName $name | Out-Null
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  }
  $tasksChanged = $true
  Set-TaskRoot $newRoot
  $oldStopped = $true
  Stop-RootProcesses $oldRoot
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3001 remained occupied' }
  Start-Root $newRoot
  $result.switched = $true
} catch {
  $result.error = $_.Exception.Message
  if ($oldStopped) {
    Stop-RootProcesses $newRoot
    Set-TaskRoot $oldRoot
    try {
      Start-Root $oldRoot
      $result.rolledBack = $true
    } catch {
      $result.rollbackError = $_.Exception.Message
    }
  }
} finally {
  if ($tasksChanged) {
    foreach ($name in $taskNames) { Enable-ScheduledTask -TaskName $name | Out-Null }
  }
  $result.finishedAt = [DateTimeOffset]::Now.ToString('o')
}

$result | ConvertTo-Json -Depth 6
if (-not $result.switched) { exit 1 }
