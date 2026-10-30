$ErrorActionPreference = 'Stop'
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\deploy-cut-multisource-n5-once.ps1'
$tokens = $null; $errors = $null
[void][Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | ForEach-Object Message | Out-String) }
$output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -OfflineTest
if ($LASTEXITCODE -ne 0) { throw "Offline test process failed: $output" }
$result = $output | Select-Object -Last 1 | ConvertFrom-Json
foreach ($name in @('adminNonAdminRouting','incompleteSnapshotZeroWrites','n5Parsing','badCandidateRejected','failureAutomaticRollback','rollbackDirection')) {
  if ($result.$name -ne $true) { throw "Offline assertion failed: $name" }
}
Write-Output "PASS syntax=1 offline=6 targetConcurrency=5"
