$ErrorActionPreference = 'Stop'
$release = 'D:\CUT-Releases\20261030-production-first-r11'
$artifacts = Join-Path $PSScriptRoot '..\artifacts\internal-cut-deploy-20261031'
$artifacts = [IO.Path]::GetFullPath($artifacts)
$files = @('worker\batch-renderer.mjs', 'lib\internal-cut-repair.mjs')
$protected = @('.env.local', 'config\cutflow-runtime.json', 'config\classic-task-isolation.json', 'data\ai-provider-config.json', 'data\classic-integration.json', 'data\batches.json', 'data\templates.json', 'data\users.json', 'data\classic-multisource.json')
$state = [ordered]@{ capturedAt = (Get-Date).ToString('o'); release = $release; hashes = @{}; tasks = @(); buildId = (Get-Content -LiteralPath (Join-Path $release '.next-production-first-r11\BUILD_ID') -Raw).Trim() }
foreach ($relative in $protected) {
  $target = Join-Path $release $relative
  if (Test-Path -LiteralPath $target) { $state.hashes[$relative] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash }
}
foreach ($name in @('Cutflow Morning Website', 'Cutflow Worker Startup')) {
  $task = Get-ScheduledTask -TaskName $name
  $state.tasks += @{ name = $name; actions = @($task.Actions | Select-Object Execute, Arguments, WorkingDirectory); enabled = $task.Settings.Enabled }
}
$beforeRenderer = Join-Path $artifacts 'before\worker\batch-renderer.mjs'
if ((Get-FileHash -LiteralPath $beforeRenderer).Hash -ne (Get-FileHash -LiteralPath (Join-Path $release $files[0])).Hash) { throw 'Live renderer changed since audit' }
if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { throw 'Web appeared during deployment; inspect ownership before installing' }
$repairExists = Test-Path -LiteralPath (Join-Path $release $files[1])
$state['repairModuleExisted'] = $repairExists
if ($repairExists) {
  New-Item -ItemType Directory -Force -Path (Join-Path $artifacts 'before\lib') | Out-Null
  Copy-Item -LiteralPath (Join-Path $release $files[1]) -Destination (Join-Path $artifacts 'before\lib\internal-cut-repair.mjs')
}
$state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $artifacts 'before-state.json') -Encoding UTF8
foreach ($relative in $files) {
  Copy-Item -LiteralPath (Join-Path $artifacts "candidate\$relative") -Destination (Join-Path $release $relative)
  if ((Get-FileHash -LiteralPath (Join-Path $artifacts "candidate\$relative")).Hash -ne (Get-FileHash -LiteralPath (Join-Path $release $relative)).Hash) { throw "Installed hash mismatch: $relative" }
}
Write-Output 'Installed exactly two modules; hashes match the tested candidate. Services not started yet.'
