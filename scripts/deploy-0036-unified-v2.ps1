[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$candidate = 'D:\CUT-Releases\20261029-unified-v2-r10'
$old = 'D:\CUT-Releases\20261028-multisource-duration-r9'
$names = @('Cutflow Morning Website', 'Cutflow Worker Startup')
$evidence = Join-Path $repository 'artifacts\0036'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$snapshots = @()
foreach ($name in $names) {
  $task = Get-ScheduledTask -TaskName $name
  if ($task.Actions[0].WorkingDirectory -ne $old) { throw "Unexpected active pointer: $name" }
  $xml = Export-ScheduledTask -TaskName $name
  $xml | Set-Content -LiteralPath (Join-Path $evidence ($name.Replace(' ', '-') + '.xml')) -Encoding UTF8
  $snapshots += @{ name = $name; xml = $xml; state = [string]$task.State }
}
git -C $repository status --short --branch | Set-Content -LiteralPath (Join-Path $evidence 'git-status-before.txt') -Encoding UTF8
$queue = Get-Content -LiteralPath (Join-Path $old 'data\service-queue.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($queue.tasks | Where-Object { $_.status -in @('running', 'leased', 'processing') }).Count) { throw 'Active service queue tasks' }

function Get-RootProcesses([string]$root) {
  $prefix = $root.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('node.exe', 'powershell.exe', 'wscript.exe', 'cscript.exe') -and
    $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($prefix)
  })
}
function Stop-RootStable([string]$root) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $processes = @(Get-RootProcesses $root)
    foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 750
  } while ($processes.Count -and (Get-Date) -lt $deadline)
  if (@(Get-RootProcesses $root).Count) { throw 'Release processes remain after bounded stop' }
}
function Set-TaskRoot([string]$root) {
  foreach ($name in $names) {
    $arguments = '//B //Nologo "' + (Join-Path $root 'scripts\ensure-cutflow-hidden.vbs') + '"'
    if ($name -eq 'Cutflow Morning Website') { $arguments += ' -OpenBrowser' }
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $root
    Set-ScheduledTask -TaskName $name -Action $action | Out-Null
  }
}
function Start-Root([string]$root) {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-cutflow.ps1') -NoBrowser -SkipAccountCheck
  if ($LASTEXITCODE -ne 0) { throw "Startup failed: $LASTEXITCODE" }
}
$result = [ordered]@{
  instructionId = '0036'; startedAt = [DateTimeOffset]::Now.ToString('o')
  oldRoot = $old; candidateRoot = $candidate; switched = $false; rolledBack = $false
  beforeProcesses = @(Get-RootProcesses $old | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
}
try {
  foreach ($name in $names) {
    Disable-ScheduledTask -TaskName $name | Out-Null
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  }
  Set-TaskRoot $candidate
  Stop-RootStable $old
  if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3001 remains occupied' }
  Start-Root $candidate
  if ((Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 10).StatusCode -ne 200) { throw 'Root HTTP gate failed' }
  $heartbeat = Get-Content -LiteralPath (Join-Path $candidate 'data\classic-multisource-heartbeat.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$($heartbeat.pid)"
  if (-not $worker.CommandLine.Replace('/', '\').Contains($candidate + '\')) { throw 'Multisource worker belongs to another release' }
  $result.switched = $true
} catch {
  $result.error = $_.Exception.Message
  Stop-RootStable $candidate
  foreach ($snapshot in $snapshots) { Register-ScheduledTask -TaskName $snapshot.name -Xml $snapshot.xml -Force | Out-Null }
  try { Start-Root $old; $result.rolledBack = $true } catch { $result.rollbackError = $_.Exception.Message }
} finally {
  foreach ($name in $names) { Enable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null }
  $result.finishedAt = [DateTimeOffset]::Now.ToString('o')
  $result.activeProcesses = @(Get-RootProcesses $(if ($result.switched) { $candidate } else { $old }) | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'deployment.json') -Encoding UTF8
}
$result | ConvertTo-Json -Depth 8
if (-not $result.switched) { exit 1 }
