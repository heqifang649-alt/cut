param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$mutex = New-Object System.Threading.Mutex($false, 'Local\CutflowAvailability')
$held = $false
try {
  $held = $mutex.WaitOne(0)
  if (-not $held) { return }
  $healthy = $false
  try {
    $response = Invoke-WebRequest 'http://localhost:3001/' -UseBasicParsing -TimeoutSec 10
    $healthy = $response.StatusCode -eq 200
  } catch {}
  $fleet = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains((Join-Path $portalRoot 'worker\fleet-supervisor.mjs'))
  }
  if (-not $healthy -or -not $fleet) {
    if (-not $healthy) {
      # Only restart this project's web process; workers and active jobs stay alive.
      $web = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains((Join-Path $portalRoot 'node_modules\next\dist\bin\next')) -and
        $_.CommandLine -match 'start\s+-p\s+3001'
      }
      foreach ($entry in $web) { Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $launchArgs = @{ NoBrowser = $true; SkipAccountCheck = $true }
    $statePath = Join-Path $portalRoot 'data\production-path.json'
    if (Test-Path -LiteralPath $statePath) {
      $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      $launchArgs.ControlA = ($state.controlA -eq $true)
    }
    & (Join-Path $PSScriptRoot 'start-cutflow.ps1') @launchArgs
  }
  if ($OpenBrowser) {
    . (Join-Path $PSScriptRoot 'cutflow-lan-url.ps1')
    Start-Process (Get-CutflowLanUrl)
  }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
