param([string]$CodexHome)

$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$runtime = Get-Content -LiteralPath (Join-Path $portalRoot 'config\cutflow-runtime.json') -Raw | ConvertFrom-Json
$codexExe = [string]$runtime.codexCliExecutable
$runtimeNode = [string]$runtime.nodeExecutable
if (-not $CodexHome) { $CodexHome = [string]$runtime.codexHome }
$backupRoot = Join-Path (Join-Path ([string]$runtime.runtimeCacheRoot) 'account-backups') (Get-Date -Format 'yyyyMMdd-HHmmss')
$authPath = Join-Path $CodexHome 'auth.json'

if (-not $codexExe) { throw 'Codex CLI was not found.' }
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) {
  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
}

$env:CODEX_HOME = $CodexHome
$env:XDG_CACHE_HOME = [string]$runtime.runtimeCacheRoot
$env:TEMP = [string]$runtime.runtimeTempRoot
$env:TMP = [string]$runtime.runtimeTempRoot

if (Test-Path -LiteralPath $authPath -PathType Leaf) {
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  Copy-Item -LiteralPath $authPath -Destination (Join-Path $backupRoot 'auth.json') -Force
}

Write-Host 'Switching the Codex account used by the Cutflow Worker. Complete the browser sign-in when prompted.' -ForegroundColor Cyan
& $codexExe logout
& $codexExe login --device-auth
if ($LASTEXITCODE -ne 0) {
  $backupAuth = Join-Path $backupRoot 'auth.json'
  if (Test-Path -LiteralPath $backupAuth -PathType Leaf) {
    Copy-Item -LiteralPath $backupAuth -Destination $authPath -Force
  }
  throw 'New account login failed. The previous Worker credential was restored.'
}

$checkOutput = & $runtimeNode (Join-Path $portalRoot 'scripts\check-codex.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Login completed, but the Codex connection check failed.' }
$check = $checkOutput | ConvertFrom-Json
if (-not $check.ready) { throw "New account readiness check failed: $($check.response)" }

@{
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
  codexHome = $CodexHome
  ready = $true
  requiresWorkerRestart = $true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $portalRoot 'data\codex-account-state.json') -Encoding UTF8

Write-Host 'The new Codex account is verified. Run scripts\restart-cutflow.ps1 to activate it.' -ForegroundColor Green
