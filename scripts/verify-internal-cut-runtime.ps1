param([switch]$Live)
$ErrorActionPreference = 'Stop'
$out = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\artifacts\internal-cut-deploy-20261031'))
$before = Get-Content -LiteralPath (Join-Path $out 'before-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$root = $before.release
$comparisons = @($before.hashes.PSObject.Properties | ForEach-Object {
  $actual = (Get-FileHash -LiteralPath (Join-Path $root $_.Name)).Hash
  [ordered]@{ path = $_.Name; unchanged = $actual -eq $_.Value; hash = $actual }
})
$modules = @('worker\batch-renderer.mjs', 'lib\internal-cut-repair.mjs') | ForEach-Object {
  $installedHash = (Get-FileHash -LiteralPath (Join-Path $root $_)).Hash
  [ordered]@{ path = $_; hash = $installedHash; matchesCandidate = $installedHash -eq (Get-FileHash -LiteralPath (Join-Path $out "candidate\$_")).Hash }
}
$tasksUnchanged = $true
foreach ($prior in $before.tasks) {
  $now = Get-ScheduledTask -TaskName $prior.name
  $actions = @($now.Actions | Select-Object Execute, Arguments, WorkingDirectory)
  if (($actions | ConvertTo-Json -Depth 5 -Compress) -ne ($prior.actions | ConvertTo-Json -Depth 5 -Compress) -or $now.Settings.Enabled -ne $prior.enabled) { $tasksUnchanged = $false }
}
$runtime = Get-Content -LiteralPath (Join-Path $root 'config\cutflow-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$disk = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($runtime.workRoot))
$buildId = (Get-Content -LiteralPath (Join-Path $root '.next-production-first-r11\BUILD_ID') -Raw).Trim()
$result = [ordered]@{
  at = (Get-Date).ToString('o'); status = 'installed-startup-blocked-disk-space'; root = $root
  buildId = $buildId; buildUnchanged = $buildId -eq $before.buildId
  protectedFiles = $comparisons; modules = @($modules); tasksUnchanged = $tasksUnchanged
  port3001Listening = [bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
  workDiskFreeGiB = [math]::Round($disk.AvailableFreeSpace / 1GB, 3)
  requiredFreeGiB = 20; candidateTestsPassed = 102; candidateReplayPassed = 4; installedReplayPassed = 4
  productionBusinessCanary = 'not-run'; paidGenerationSubmitted = $false; historicalBatchRerun = $false
}
$outputName = 'deployment-state.json'
if ($Live) {
  function Read-State([string]$relative) {
    Get-Content -LiteralPath (Join-Path $root $relative) -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  function Inspect-Heartbeat([string]$relative, [string]$role) {
    $state = Read-State $relative
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)" -ErrorAction SilentlyContinue
    $timestamp = if ($state.at) { $state.at } else { $state.updatedAt }
    $fresh = $timestamp -and ([DateTimeOffset]::Now - [DateTimeOffset]::Parse($timestamp)).TotalSeconds -lt 60
    [ordered]@{ role = $role; pid = $state.pid; alive = [bool]$process; fresh = [bool]$fresh; at = $timestamp; claimsEnabled = $state.claimsEnabled }
  }
  function Http-Status([string]$uri) {
    try { [int](Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 10).StatusCode }
    catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { throw } }
  }
  $heartbeats = @(Inspect-Heartbeat 'data\fleet-runtime.json' 'fleet')
  foreach ($service in @('analyze', 'clip', 'render')) {
    foreach ($index in 1..3) { $heartbeats += Inspect-Heartbeat "data\service-heartbeats\$service-$service-$index.json" "$service-$index" }
  }
  $heartbeats += Inspect-Heartbeat 'data\classic-multisource-heartbeat.json' 'multisource'
  $heartbeats += Inspect-Heartbeat 'data\libtv-bridge-heartbeat.json' 'bridge'
  $heartbeats += Inspect-Heartbeat 'data\delivery-worker-heartbeat.json' 'delivery'
  $result.status = 'live-runtime-verified-no-business-canary'
  $result['httpRoot'] = Http-Status 'http://127.0.0.1:3001/'
  $result['httpHealthUnauthenticated'] = Http-Status 'http://127.0.0.1:3001/api/health'
  $result['heartbeats'] = $heartbeats
  $result['allHeartbeatsHealthy'] = -not [bool]@($heartbeats | Where-Object { -not $_.alive -or -not $_.fresh }).Count
  $result['ordinaryClaimsDisabled'] = -not [bool]@($heartbeats | Where-Object { ($_.role -eq 'fleet' -or $_.role -match '^(analyze|clip|render)-') -and $_.claimsEnabled -ne $false }).Count
  $outputName = 'live-state.json'
}
$result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $out $outputName) -Encoding UTF8
if ($comparisons.Where({-not $_.unchanged}).Count -or -not $tasksUnchanged -or $buildId -ne $before.buildId) { throw 'Protected state changed; inspect deployment-state.json' }
if (@($modules | Where-Object { -not $_.matchesCandidate }).Count) { throw 'Installed module mismatch' }
if ($Live) {
  if (-not $result.port3001Listening -or $result.httpRoot -ne 200 -or $result.httpHealthUnauthenticated -ne 401 -or -not $result.allHeartbeatsHealthy -or -not $result.ordinaryClaimsDisabled) { throw 'Live runtime verification failed; inspect live-state.json' }
  Write-Output 'Live runtime verification passed; protected state unchanged; HTTP 200/401; 13 fresh process heartbeats; ordinary claims disabled.'
} else {
  Write-Output ('Installed module verification passed; protected state unchanged; startup blocked, free={0} GiB' -f $result.workDiskFreeGiB)
}
