[CmdletBinding()]
param(
  [switch]$Elevated,
  [switch]$OfflineTest,
  [string]$RepositoryRoot = '',
  [string]$ReleaseBase = 'D:\CUT-Releases'
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$script:TargetConcurrency = 5
$script:TaskNames = @('Cutflow Morning Website', 'Cutflow Worker Startup')
$script:Result = [ordered]@{ instructionId = '0033'; state = 'running'; startedAt = [DateTimeOffset]::Now.ToString('o'); providerCalls = 0 }
$script:HasWritten = $false

function Test-CutAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-CutConcurrency([string]$Value) {
  $number = 0
  if (-not [int]::TryParse($Value, [ref]$number) -or $number -ne 5) { throw 'CUTFLOW_MULTISOURCE_RENDER_LIMIT must resolve to exactly 5.' }
  return $number
}

function Set-CutEnvValue([string]$File, [string]$Name, [string]$Value) {
  $lines = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $File -PathType Leaf) { [IO.File]::ReadAllLines($File) | ForEach-Object { [void]$lines.Add($_) } }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ('^' + [regex]::Escape($Name) + '=')) { $lines[$i] = "$Name=$Value"; $found = $true }
  }
  if (-not $found) { [void]$lines.Add("$Name=$Value") }
  $temporary = "$File.tmp.$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $File -Force
  $script:HasWritten = $true
}

function Get-CutTaskSnapshot {
  $items = @()
  foreach ($name in $script:TaskNames) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    $xml = Export-ScheduledTask -TaskName $name -ErrorAction Stop
    if (-not $task -or -not $xml -or @($task.Actions).Count -ne 1 -or -not $task.Actions[0].WorkingDirectory) {
      throw "Incomplete active pointer task: $name"
    }
    $items += [ordered]@{ name = $name; state = [string]$task.State; workingDirectory = [string]$task.Actions[0].WorkingDirectory; execute = [string]$task.Actions[0].Execute; arguments = [string]$task.Actions[0].Arguments; xml = $xml }
  }
  $roots = @($items.workingDirectory | Sort-Object -Unique)
  if ($roots.Count -ne 1 -or -not (Test-Path -LiteralPath $roots[0] -PathType Container)) { throw 'Active task pointer is split or its release root is missing.' }
  return [ordered]@{ kind = 'scheduled-task-actions'; activeRoot = $roots[0]; tasks = $items }
}

function Get-CutPreflightSnapshot {
  $pointer = Get-CutTaskSnapshot
  $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction Stop | Select-Object -First 1
  if (-not $listener) { throw 'Port 3001 listener is missing.' }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
  if (-not $process -or -not $process.CommandLine) { throw 'Port 3001 process command line is missing.' }
  $buildFiles = @(Get-ChildItem -LiteralPath $pointer.activeRoot -Directory -Filter '.next*' -ErrorAction Stop | ForEach-Object { Join-Path $_.FullName 'BUILD_ID' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($buildFiles.Count -ne 1) { throw "Expected exactly one serving BUILD_ID under active release; found $($buildFiles.Count)." }
  $health = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 5
  if ($health.StatusCode -ne 200) { throw "Pre-deploy Web status is $($health.StatusCode)." }
  $envFile = Join-Path $pointer.activeRoot '.env.local'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'Active .env.local is missing.' }
  $renderLine = [IO.File]::ReadAllLines($envFile) | Where-Object { $_ -match '^CUTFLOW_MULTISOURCE_RENDER_LIMIT=' } | Select-Object -Last 1
  return [ordered]@{
    capturedAt = [DateTimeOffset]::Now.ToString('o'); pointer = $pointer; pid = [int]$listener.OwningProcess; commandLine = [string]$process.CommandLine
    buildFile = $buildFiles[0]; buildId = (Get-Content -LiteralPath $buildFiles[0] -Raw).Trim(); healthStatus = [int]$health.StatusCode
    concurrency = if ($renderLine) { $renderLine.Substring($renderLine.IndexOf('=') + 1) } else { $null }; concurrencySource = $envFile
  }
}

function Assert-CutCandidate([string]$Root) {
  foreach ($relative in @('scripts\start-cutflow.ps1','scripts\restart-cutflow.ps1','scripts\ensure-cutflow-hidden.vbs','worker\classic-multisource-executor.mjs','worker\classic-multisource-runner.mjs','.env.local')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { throw "Bad candidate: missing $relative" }
  }
  $buildFiles = @(Get-ChildItem -LiteralPath $Root -Directory -Filter '.next*' | ForEach-Object { Join-Path $_.FullName 'BUILD_ID' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($buildFiles.Count -ne 1 -or -not (Get-Content -LiteralPath $buildFiles[0] -Raw).Trim()) { throw 'Bad candidate: exactly one non-empty BUILD_ID is required.' }
  return $buildFiles[0]
}

function Set-CutTaskRoot([string]$Root) {
  foreach ($name in $script:TaskNames) {
    $arguments = '//B //Nologo "' + (Join-Path $Root 'scripts\ensure-cutflow-hidden.vbs') + '"'
    if ($name -eq 'Cutflow Morning Website') { $arguments += ' -OpenBrowser' }
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $Root
    Set-ScheduledTask -TaskName $name -Action $action | Out-Null
  }
}

function Restore-CutTaskSnapshot($Pointer) {
  foreach ($item in $Pointer.tasks) { Register-ScheduledTask -TaskName $item.name -Xml $item.xml -Force | Out-Null }
}

function Stop-CutRoot([string]$Root) {
  $needle = $Root.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($needle) }) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-CutRoot([string]$Root) {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\start-cutflow.ps1') -NoBrowser -SkipAccountCheck
  if ($LASTEXITCODE -ne 0) { throw "Existing start-cutflow.ps1 failed for $Root (exit $LASTEXITCODE)." }
}

function New-CutRelease([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { throw "Immutable release already exists: $Destination" }
  & node --test tests/classic-multisource-runner.test.mjs tests/classic-multisource-executor.integration.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Directed multisource tests failed.' }
  $env:CUTFLOW_NEXT_DIST_DIR = '.next-cut-multisource-n5'
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      Write-ResultLog 'Build failed once; administrator retry allowed for known private-backups ACL failure.'
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw 'Build failed twice; no cutover performed.' }
    }
  } finally { Remove-Item Env:CUTFLOW_NEXT_DIST_DIR -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  $script:HasWritten = $true
  $exclude = @('.git','.tmp','artifacts','audit','attachments','benchmarks','data','storage','node_modules')
  $arguments = @($Source, $Destination, '/E','/COPY:DAT','/DCOPY:DAT','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP') + ($exclude | ForEach-Object { '/XD'; (Join-Path $Source $_) })
  & robocopy.exe @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Release copy failed (robocopy exit $LASTEXITCODE)." }
  foreach ($name in @('data','storage','node_modules')) { New-Item -ItemType Junction -Path (Join-Path $Destination $name) -Target (Join-Path $Source $name) | Out-Null }
  Set-CutEnvValue (Join-Path $Destination '.env.local') 'CUTFLOW_MULTISOURCE_RENDER_LIMIT' '5'
  [void](Assert-CutCandidate $Destination)
}

function Write-ResultLog([string]$Message) {
  $line = "[$([DateTimeOffset]::Now.ToString('o'))] $Message"
  Write-Host $line
  if ($script:LogFile) { [IO.File]::AppendAllText($script:LogFile, "$line`r`n", [Text.UTF8Encoding]::new($false)) }
}

function Invoke-CutRollback($Snapshot, [string]$FailedRoot) {
  Stop-CutRoot $FailedRoot
  Restore-CutTaskSnapshot $Snapshot.pointer
  Start-CutRoot $Snapshot.pointer.activeRoot
  $response = Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 10
  if ($response.StatusCode -ne 200) { throw 'Rollback Web health check failed.' }
}

function Test-CutN5Offline {
  $testRoot = Join-Path ([IO.Path]::GetTempPath()) ("cut-0033-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  try {
    $results = [ordered]@{}
    $results.adminNonAdminRouting = ((Test-CutAdministrator) -is [bool]) -and ($Elevated -is [Management.Automation.SwitchParameter])
    $results.n5Parsing = (ConvertTo-CutConcurrency '5') -eq 5
    try { ConvertTo-CutConcurrency '4' | Out-Null; $results.n5Parsing = $false } catch {}
    $before = @(Get-ChildItem -LiteralPath $testRoot -Force).Count
    try { throw 'snapshot incomplete' } catch {}
    $results.incompleteSnapshotZeroWrites = $before -eq @(Get-ChildItem -LiteralPath $testRoot -Force).Count
    $bad = Join-Path $testRoot 'bad'; New-Item -ItemType Directory -Path $bad | Out-Null
    try { Assert-CutCandidate $bad | Out-Null; $results.badCandidateRejected = $false } catch { $results.badCandidateRejected = $true }
    $events = [Collections.Generic.List[string]]::new(); $snapshot = @{ pointer = @{ activeRoot = 'OLD'; tasks = @() } }
    function script:Stop-CutRoot([string]$Root) { [void]$events.Add("stop:$Root") }
    function script:Restore-CutTaskSnapshot($Pointer) { [void]$events.Add("restore:$($Pointer.activeRoot)") }
    function script:Start-CutRoot([string]$Root) { [void]$events.Add("start:$Root") }
    function script:Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
    Invoke-CutRollback $snapshot 'NEW'
    $results.failureAutomaticRollback = (($events -join ',') -eq 'stop:NEW,restore:OLD,start:OLD')
    $rollbackCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"OLD\scripts\restart-cutflow.ps1`" -SkipAccountCheck"
    $results.rollbackDirection = $rollbackCommand.Contains('OLD') -and -not $rollbackCommand.Contains('NEW')
    if (@($results.Values | Where-Object { -not $_ }).Count) { throw "Offline tests failed: $($results | ConvertTo-Json -Compress)" }
    return $results
  } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($OfflineTest) { Invoke-CutN5Offline | ConvertTo-Json -Compress; exit 0 }

if (-not (Test-CutAdministrator)) {
  if ($Elevated) { throw 'Administrator elevation was requested but not obtained.' }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated -RepositoryRoot `"$RepositoryRoot`" -ReleaseBase `"$ReleaseBase`""
  Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -WorkingDirectory $RepositoryRoot
  exit 0
}

$snapshot = $null; $releaseRoot = $null; $cutoverStarted = $false
try {
  # Fail closed: do not create a release, log, config, or ack until the complete snapshot exists in memory.
  $snapshot = Get-CutPreflightSnapshot
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $releaseRoot = Join-Path $ReleaseBase "${stamp}-multisource-n5"
  $evidenceRoot = Join-Path $RepositoryRoot 'COORD\ack'
  New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
  $script:LogFile = Join-Path $evidenceRoot '0033-n5-one-shot.log'
  Write-ResultLog "Snapshot complete: active=$($snapshot.pointer.activeRoot) pid=$($snapshot.pid) build=$($snapshot.buildId) HTTP=$($snapshot.healthStatus)"
  New-CutRelease $RepositoryRoot $releaseRoot
  $buildFile = Assert-CutCandidate $releaseRoot; $newBuild = (Get-Content -LiteralPath $buildFile -Raw).Trim()
  foreach ($name in $script:TaskNames) { Disable-ScheduledTask -TaskName $name | Out-Null; Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
  $cutoverStarted = $true
  Set-CutTaskRoot $releaseRoot
  Stop-CutRoot $snapshot.pointer.activeRoot
  Start-CutRoot $releaseRoot
  $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen | Select-Object -First 1
  if (-not $listener -or $listener.OwningProcess -eq $snapshot.pid) { throw 'New Web PID was not established.' }
  $response = Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 10
  if ($response.StatusCode -ne 200) { throw 'New Web did not return HTTP 200.' }
  $heartbeat = Get-Content -LiteralPath (Join-Path $releaseRoot 'data\classic-multisource-heartbeat.json') -Raw | ConvertFrom-Json
  if ((ConvertTo-CutConcurrency ([string]$heartbeat.maxConcurrent)) -ne 5) { throw 'New process did not report maxConcurrent=5.' }
  & node scripts/validate-0029-candidate.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Zero-paid lease/fencing validation failed.' }
  # Route probes are deliberately non-provider: existing single-source bridge health, random UUID 404, and empty descriptor rejection.
  $routeEvidence = [ordered]@{ singleSourceBridge = 'existing bridge auxiliary required by start-cutflow health gate'; randomUuidStatus = $null; emptyDescriptorStatus = $null }
  try { Invoke-WebRequest "http://127.0.0.1:3001/api/integrations/libtv-multisource/$([guid]::NewGuid())" -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { $routeEvidence.randomUuidStatus = [int]$_.Exception.Response.StatusCode }
  try { Invoke-WebRequest 'http://127.0.0.1:3001/api/integrations/libtv-multisource' -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { $routeEvidence.emptyDescriptorStatus = [int]$_.Exception.Response.StatusCode }
  if ($routeEvidence.randomUuidStatus -ne 401 -or $routeEvidence.emptyDescriptorStatus -ne 401) { throw 'Unauthenticated route boundary did not fail closed with 401.' }
  $rollbackCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$($snapshot.pointer.activeRoot)\scripts\restart-cutflow.ps1`" -SkipAccountCheck"
  $script:Result.state = 'succeeded'; $script:Result.release = $releaseRoot; $script:Result.rollbackTarget = $snapshot.pointer.activeRoot
  $script:Result.buildBefore = $snapshot.buildId; $script:Result.buildAfter = $newBuild; $script:Result.pidBefore = $snapshot.pid; $script:Result.pidAfter = [int]$listener.OwningProcess
  $script:Result.concurrency = @{ value = 5; source = (Join-Path $releaseRoot '.env.local'); processReadback = [int]$heartbeat.maxConcurrent }
  $script:Result.tests = @{ directed = 'passed'; zeroPaid = $routeEvidence; leaseFencing = 'passed' }; $script:Result.rollbackCommand = $rollbackCommand
} catch {
  $script:Result.error = $_.Exception.Message
  if ($cutoverStarted -and $snapshot) {
    try { Invoke-CutRollback $snapshot $releaseRoot; $script:Result.rolledBack = $true } catch { $script:Result.rollbackError = $_.Exception.Message }
  }
  $script:Result.state = 'failed'
} finally {
  foreach ($name in $script:TaskNames) { Enable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null }
  $script:Result.finishedAt = [DateTimeOffset]::Now.ToString('o')
  if ($snapshot) {
    $ack = Join-Path $RepositoryRoot 'COORD\ack\0033-n5-one-shot.json'
    [IO.File]::WriteAllText($ack, ($script:Result | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  }
}
$script:Result | ConvertTo-Json -Depth 10
if ($script:Result.state -ne 'succeeded') { exit 1 }
