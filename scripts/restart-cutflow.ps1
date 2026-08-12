$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $portalRoot 'data'

# Heartbeats identify the preferred instance but may be stale. Stop every
# project worker process so a restart cannot leave an older duplicate taking
# the same task lease or Codex temporary resources.
$nodeProcesses = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine }
$projectWorkers = $nodeProcesses | Where-Object {
  $normalizedCommand = if ($_.CommandLine) { $_.CommandLine.Replace('/', '\') } else { '' }
  $normalizedCommand -match [regex]::Escape($portalRoot) -and
  $normalizedCommand -match 'worker\\(processor|service-runner|service-supervisor|template-processor|delivery-watcher|chatcut-sync)\.mjs'
}
# A launcher can start Supervisor with a relative script path, which does not
# include $portalRoot in CommandLine. Include only a Supervisor whose direct
# child is a project-owned service runner; this avoids touching other apps.
$relativeProjectSupervisors = foreach ($supervisor in $nodeProcesses) {
  $normalizedCommand = $supervisor.CommandLine.Replace('/', '\')
  if ($normalizedCommand -notmatch 'worker\\service-supervisor\.mjs') { continue }
  $child = $nodeProcesses | Where-Object {
    $_.ParentProcessId -eq $supervisor.ProcessId -and
    ($_.CommandLine.Replace('/', '\') -match [regex]::Escape($portalRoot)) -and
    ($_.CommandLine.Replace('/', '\') -match 'worker\\service-runner\.mjs')
  } | Select-Object -First 1
  if ($null -ne $child) { $supervisor }
}
$projectWorkers = @($projectWorkers + $relativeProjectSupervisors | Sort-Object ProcessId -Unique)
foreach ($process in $projectWorkers) {
  try {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
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
