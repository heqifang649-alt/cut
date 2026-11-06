$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$links = @(
  @{ name = 'node'; target = (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime.previous-4e64a152-dddb-4c93-b23b-79b336986466\dependencies\node'); executable = 'bin\node.exe' },
  @{ name = 'python'; target = 'E:\DevCache\cache\codex-runtimes\codex-primary-runtime\dependencies\python'; executable = 'python.exe' }
)
foreach ($link in $links) {
  $target = [IO.Path]::GetFullPath($link.target)
  if (-not (Test-Path -LiteralPath (Join-Path $target $link.executable) -PathType Leaf)) { throw "Missing runtime executable in $target" }
  if (Test-Path -LiteralPath (Join-Path $destination $link.name)) { throw "Runtime path already exists: $($link.name); inspect instead of overwriting" }
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$evidence = @()
foreach ($link in $links) {
  $path = Join-Path $destination $link.name
  New-Item -ItemType Junction -Path $path -Target $link.target | Out-Null
  $executable = Join-Path $path $link.executable
  $version = & $executable --version
  if ($LASTEXITCODE -ne 0) { throw "Runtime version check failed: $path" }
  $evidence += [ordered]@{ path = $path; target = $link.target; version = "$version"; sha256 = (Get-FileHash -LiteralPath $executable).Hash }
}
$out = Join-Path $PSScriptRoot '..\artifacts\internal-cut-deploy-20261031\runtime-path-recovery.json'
@{ at = (Get-Date).ToString('o'); links = $evidence; productionConfigChanged = $false; previousPythonVersion = 'unconfirmed' } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $out -Encoding UTF8
Write-Output 'Restored only the two missing executable directory paths; runtime configuration unchanged.'
