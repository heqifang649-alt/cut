$ErrorActionPreference = 'Stop'
$root = 'D:\CUT-Releases\20261027-multisource-canary-r3'
$rollback = 'D:\CUT-Releases\20261027-multisource-r1'
$taskNames = @('Cutflow Morning Website', 'Cutflow Worker Startup')
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$result = [ordered]@{ startedAt = [DateTimeOffset]::Now.ToString('o'); release = $root; rollbackTarget = $rollback; admission = 'CLOSED'; rolledBack = $false }
function Set-TaskRoot([string]$target) {
  foreach ($name in $taskNames) {
    $arguments = '//B //Nologo "' + (Join-Path $target 'scripts\ensure-cutflow-hidden.vbs') + '"'
    if ($name -eq 'Cutflow Morning Website') { $arguments += ' -OpenBrowser' }
    Set-ScheduledTask -TaskName $name -Action (New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $target) | Out-Null
  }
}
function Stop-Root([string]$target) {
  $needle = $target + '\'
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($needle) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Set-Admission([bool]$enabled) {
  $file = Join-Path $root '.env.local'
  $lines = [Collections.Generic.List[string]]::new(); [IO.File]::ReadAllLines($file) | ForEach-Object { [void]$lines.Add($_) }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^CUTFLOW_MULTISOURCE_ENABLED=') { $lines[$i] = 'CUTFLOW_MULTISOURCE_ENABLED=' + $enabled.ToString().ToLowerInvariant(); $found = $true }
  }
  if (-not $found) { [void]$lines.Add('CUTFLOW_MULTISOURCE_ENABLED=' + $enabled.ToString().ToLowerInvariant()) }
  $temp = $file + '.tmp'; [IO.File]::WriteAllLines($temp, $lines, [Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $temp -Destination $file -Force
}
function Start-Root([string]$target) {
  & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $target 'scripts\start-cutflow.ps1') -NoBrowser -SkipAccountCheck
  if ($LASTEXITCODE -ne 0) { throw "Startup failed for $target" }
}
try {
  foreach ($name in $taskNames) { Disable-ScheduledTask -TaskName $name | Out-Null; Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
  Set-Admission $true
  Stop-Root $root
  Start-Root $root
  $result.admission = 'OPEN'
} catch {
  $result.error = $_.Exception.Message
  Set-Admission $false
  Stop-Root $root
  Set-TaskRoot $rollback
  try { Start-Root $rollback; $result.rolledBack = $true } catch { $result.rollbackError = $_.Exception.Message }
} finally {
  foreach ($name in $taskNames) { Enable-ScheduledTask -TaskName $name | Out-Null }
  $result.finishedAt = [DateTimeOffset]::Now.ToString('o')
}
$result | ConvertTo-Json -Depth 5
if ($result.admission -ne 'OPEN') { exit 1 }
