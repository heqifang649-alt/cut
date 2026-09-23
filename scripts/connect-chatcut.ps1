$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$runtime = Get-Content -LiteralPath (Join-Path $portalRoot 'config\cutflow-runtime.json') -Raw | ConvertFrom-Json
$codexHome = [string]$runtime.codexHome
$codexExe = [string]$runtime.codexCliExecutable

if (-not $codexExe) { throw 'Codex CLI was not found.' }
$env:CODEX_HOME = $codexHome
$env:XDG_CACHE_HOME = [string]$runtime.runtimeCacheRoot
$env:TEMP = [string]$runtime.runtimeTempRoot
$env:TMP = [string]$runtime.runtimeTempRoot

Write-Host 'Connect the ChatCut account that should own editable Cutflow projects.' -ForegroundColor Cyan
& $codexExe mcp login chatcut
if ($LASTEXITCODE -ne 0) { throw 'ChatCut OAuth login failed.' }

@{
  ready = $true
  connectedAt = (Get-Date).ToUniversalTime().ToString('o')
  codexHome = $codexHome
  direction = 'cutflow_to_chatcut_only'
} | ConvertTo-Json | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $portalRoot 'data\chatcut-account-state.json'), $_, [System.Text.UTF8Encoding]::new($false)) }

Write-Host 'ChatCut is connected. Restart Cutflow to begin syncing editable projects.' -ForegroundColor Green
