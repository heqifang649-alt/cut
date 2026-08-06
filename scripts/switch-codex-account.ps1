param(
  [string]$CodexHome = 'D:\codex\.codex'
)

$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$codexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$codexExe = Get-ChildItem -LiteralPath $codexBinRoot -Filter codex.exe -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
$runtimeNode = 'D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$backupRoot = Join-Path 'D:\codex\account-backups' (Get-Date -Format 'yyyyMMdd-HHmmss')
$authPath = Join-Path $CodexHome 'auth.json'

if (-not $codexExe) { throw 'Codex CLI was not found.' }
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) {
  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
}

$env:CODEX_HOME = $CodexHome
$env:XDG_CACHE_HOME = 'D:\codex\cache'
$env:TEMP = 'D:\codex\tmp'
$env:TMP = 'D:\codex\tmp'

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
