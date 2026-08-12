param(
  [switch]$NoBrowser,
  [switch]$SkipAccountCheck,
  [string]$CodexHome = 'D:\codex\.codex'
)

$ErrorActionPreference = 'Stop'
# PowerShell 5.1 Start-Process bug: $env:Path 大小写重复键 (Path/PATH/path) 导致
# "已添加项。字典中的关键字:Path 所添加的关键字:PATH"。
# 清除所有变体后从 Machine+User scope 重建单一 Path 键。
foreach ($envKey in @('Path', 'PATH', 'path')) {
  [Environment]::SetEnvironmentVariable($envKey, $null, 'Process')
}
$_sysPath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$_usrPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$_cleanPath = (($_sysPath, $_usrPath) -join ';') -replace ';+', ';' -replace '^;', '' -replace ';$', ''
[Environment]::SetEnvironmentVariable('Path', $_cleanPath, 'Process')

# Node 22/24 在 Windows 11 24H2 上有 ncrypto::CSPRNG assert bug。
# --openssl-legacy-provider 绕过此 bug，crypto.randomBytes 测试通过。
$env:NODE_OPTIONS = '--openssl-legacy-provider'

$portalRoot = Split-Path -Parent $PSScriptRoot
# Codex 自带的 node v24.14.0 在 Windows 上有 ncrypto::CSPRNG assert bug。
# 临时回退到 workbuddy 自带的稳定 v22.22.2。架构层面不影响。
$runtimeRoot = 'C:\Users\尔尔\.workbuddy\binaries\node\versions\22.22.2'
$runtimeNode = Join-Path $runtimeRoot 'node.exe'
$runtimePython = 'D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$logRoot = Join-Path $portalRoot 'logs'
$dataRoot = Join-Path $portalRoot 'data'

if (-not (Test-Path -LiteralPath $runtimeNode -PathType Leaf)) { throw "Node runtime not found: $runtimeNode" }
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) { throw "Codex account home not found: $CodexHome" }
New-Item -ItemType Directory -Force -Path $logRoot, $dataRoot | Out-Null
New-Item -ItemType Directory -Force -Path 'D:\codex\tmp', 'D:\codex\cache' | Out-Null
$workerTempRoot = 'D:\codex\tmp\cutflow-workers'
$workerCacheRoot = 'D:\codex\cache\cutflow-workers'
New-Item -ItemType Directory -Force -Path $workerTempRoot, $workerCacheRoot | Out-Null
$bootstrapTemp = Join-Path $workerTempRoot 'bootstrap'
$bootstrapCache = Join-Path $workerCacheRoot 'bootstrap'
New-Item -ItemType Directory -Force -Path $bootstrapTemp, $bootstrapCache | Out-Null

$env:CODEX_HOME = $CodexHome
$env:XDG_CACHE_HOME = 'D:\codex\cache'
$env:TEMP = $bootstrapTemp
$env:TMP = $bootstrapTemp
$env:TMPDIR = $bootstrapTemp
$env:XDG_CACHE_HOME = $bootstrapCache

function Convert-CodePoints([int[]]$Codes) {
  return -join ($Codes | ForEach-Object { [char]$_ })
}

$creativeDepartment = Convert-CodePoints @(20869, 23481, 21019, 24847, 37096)
$adDelivery = Convert-CodePoints @(24191, 21578, 25104, 29255, 20132, 20184)
$newDelivery = Convert-CodePoints @(26032, 25104, 29255, 20132, 20184)
$finishedVideos = Convert-CodePoints @(25104, 29255)

$env:ALLOWED_NAS_ROOTS = "\\192.168.120.60\$creativeDepartment-fb$adDelivery;\\192.168.120.60\$newDelivery"
$env:GOLD_STANDARD_PATH = Join-Path $portalRoot 'standards\reference-sets\gc-good-20260805\gold-standard-v2.json'
$env:PYTHONPATH = 'D:\codex\cache\pydeps'
$env:PYTHON_PATH = $runtimePython

$codexReady = $false
$codexResponse = ''
$accountStatePath = Join-Path $dataRoot 'codex-account-state.json'
$previousAccountState = $null
if ($SkipAccountCheck) {
  # Skipping the probe is only a launcher optimisation.  It must never turn
  # a previously verified account into an "unavailable" account in the UI.
  # The normal start/restart path always performs a fresh probe and writes the
  # state below; this branch deliberately leaves that file untouched.
  try {
    if (Test-Path -LiteralPath $accountStatePath -PathType Leaf) {
      $previousAccountState = Get-Content -LiteralPath $accountStatePath -Raw | ConvertFrom-Json
    }
  } catch {}
  if ($previousAccountState -and $previousAccountState.ready -eq $true) {
    $codexReady = $true
    $codexResponse = [string]$previousAccountState.response
  } else {
    $codexResponse = '已跳过 Codex 账号检查，未覆盖最近一次账号状态'
  }
} else {
  $cutoff = (Get-Date).AddSeconds(20)
  $capture = $null
  do {
    try { $capture = & $runtimeNode (Join-Path $portalRoot 'scripts\check-codex.mjs') 2>&1 } catch {}
    if ($LASTEXITCODE -eq 0 -and $capture) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $cutoff)
  if ($LASTEXITCODE -eq 0 -and $capture) {
    try {
      $check = $capture | ConvertFrom-Json
      if ($check.ready) { $codexReady = $true } else { $codexResponse = [string]$check.response }
    } catch { $codexResponse = "解析失败: $capture" }
  } else {
    $codexResponse = if ($capture) { "exit=$LASTEXITCODE out=$capture" } else { 'check-codex 超时' }
  }
}

if (-not $SkipAccountCheck) {
  $accountState = @{
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    codexHome = $CodexHome
    ready = $codexReady
    response = $codexResponse
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($accountStatePath, $accountState, [System.Text.UTF8Encoding]::new($false))
}

if ($codexReady) {
  Write-Host 'Codex 账号连接正常。' -ForegroundColor Green
} else {
  Write-Host "Codex 账号不可用，自动剪辑已暂停（界面和审核仍可用）。原因：$codexResponse" -ForegroundColor Yellow
  Write-Host '登录后执行 scripts\restart-cutflow.cmd 即可恢复接单。' -ForegroundColor Yellow
}

function Test-TrackedProcess([string]$Heartbeat, [string]$CommandFragment) {
  # A heartbeat can be stale after an interrupted restart. Check the real
  # process list first so a second launcher never starts a duplicate worker.
  $existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $normalizedCommand = if ($_.CommandLine) { $_.CommandLine.Replace('/', '\') } else { '' }
    $_.Name -eq 'node.exe' -and $normalizedCommand -like "*$CommandFragment*"
  } | Select-Object -First 1
  if ($existing) { return $true }
  if (-not (Test-Path -LiteralPath $Heartbeat -PathType Leaf)) { return $false }
  try {
    $record = Get-Content -LiteralPath $Heartbeat -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    return $null -ne $process -and $process.CommandLine -like "*$CommandFragment*"
  } catch { return $false }
}

function Start-Worker([string]$Name, [string[]]$Arguments, [string]$Heartbeat, [string]$CommandFragment, [string]$ServiceInstance = '') {
  if (Test-TrackedProcess $Heartbeat $CommandFragment) { return }
  # 修复 cwd：把所有相对路径转绝对路径，避免 worker 启动时 process.cwd() 错。
  $argList = @()
  foreach ($a in $Arguments) {
    if ($a -match '^--') { $argList += $a }
    elseif ($a -match '^[a-zA-Z]:[\\/]') { $argList += $a }
    elseif ($a -match '^[\\/]') { $argList += $a }
    else {
      $joined = Join-Path $portalRoot $a
      $argList += ($joined -replace '\\', '/')
    }
  }
  $stdout = Join-Path $logRoot "$Name.stdout.log"
  $stderr = Join-Path $logRoot "$Name.stderr.log"
  $workerTemp = Join-Path $workerTempRoot $Name
  $workerCache = Join-Path $workerCacheRoot $Name
  New-Item -ItemType Directory -Force -Path $workerTemp, $workerCache | Out-Null
  # 不用 -UseNewEnvironment：worker 需要继承 NODE_OPTIONS (--openssl-legacy-provider)
  # 以及 CODEX_HOME、FFMPEG_PATH、ALLOWED_NAS_ROOTS 等自定义环境变量。
  # Path 重复键问题已在脚本顶部修复（重建单一 Path 键）。
  # Each Codex-capable service receives an isolated temporary and cache
  # directory. This prevents one service from cleaning up another service's
  # in-process app-server files.
  $originalTemp = $env:TEMP
  $originalTmp = $env:TMP
  $originalTmpDir = $env:TMPDIR
  $originalCache = $env:XDG_CACHE_HOME
  $originalServiceInstance = $env:CUTFLOW_SERVICE_INSTANCE
  try {
    $env:TEMP = $workerTemp
    $env:TMP = $workerTemp
    $env:TMPDIR = $workerTemp
    $env:XDG_CACHE_HOME = $workerCache
    if ($ServiceInstance) { $env:CUTFLOW_SERVICE_INSTANCE = $ServiceInstance }
    else { Remove-Item Env:CUTFLOW_SERVICE_INSTANCE -ErrorAction SilentlyContinue }
    Start-Process -FilePath $runtimeNode -ArgumentList $argList -WorkingDirectory $portalRoot `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden | Out-Null
  } finally {
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
    $env:TMPDIR = $originalTmpDir
    $env:XDG_CACHE_HOME = $originalCache
    if ($null -eq $originalServiceInstance) { Remove-Item Env:CUTFLOW_SERVICE_INSTANCE -ErrorAction SilentlyContinue }
    else { $env:CUTFLOW_SERVICE_INSTANCE = $originalServiceInstance }
  }
}

$listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  $nextCli = Join-Path $portalRoot 'node_modules\next\dist\bin\next'
  Start-Process -FilePath $runtimeNode -ArgumentList @($nextCli, 'start', '-p', '3001', '-H', '0.0.0.0') `
    -WorkingDirectory $portalRoot -RedirectStandardOutput (Join-Path $logRoot 'web.stdout.log') `
    -RedirectStandardError (Join-Path $logRoot 'web.stderr.log') -WindowStyle Hidden | Out-Null
} else {
  $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($webProcess.CommandLine -notlike '*next*start*-p*3001*') { throw "Port 3001 is occupied by PID $($listener.OwningProcess)" }
}

# Each stage has three independently supervised workers. Queue leases keep
# a Batch Stage exclusive while allowing different Batches to run in parallel.
foreach ($service in @('analyze', 'clip', 'render')) {
  foreach ($index in 1..3) {
    $instance = "$service-$index"
    Start-Worker "$instance-supervisor" @('worker\service-supervisor.mjs', "--service=$service", "--instance=$instance") `
      (Join-Path $dataRoot "service-heartbeats\$service-$instance.json") `
      "worker\service-supervisor.mjs*--service=$service*--instance=$instance" `
      $instance
    # Stagger process creation to avoid the Windows Node entropy-startup issue.
    Start-Sleep -Seconds 2
  }
}
Start-Worker 'template' @('worker\template-processor.mjs') (Join-Path $dataRoot 'template-worker-heartbeat.json') 'worker\template-processor.mjs'
Start-Sleep -Seconds 2
Start-Worker 'delivery' @('worker\delivery-watcher.mjs') (Join-Path $dataRoot 'delivery-worker-heartbeat.json') 'worker\delivery-watcher.mjs'
Start-Sleep -Seconds 2
Start-Worker 'chatcut' @('worker\chatcut-sync.mjs') (Join-Path $dataRoot 'chatcut-worker-heartbeat.json') 'worker\chatcut-sync.mjs'

$webReady = $false
$servicesReady = $false
$deadline = (Get-Date).AddSeconds(180)
do {
  try {
    # /api/health and /api/dashboard are intentionally authenticated after
    # multi-account isolation.  A 401 proves the web server is available
    # without leaking account or queue data to this local launcher.
    $response = Invoke-WebRequest -Uri 'http://localhost:3001/api/health' -TimeoutSec 5 -UseBasicParsing
    $webReady = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    $statusCode = $null
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
    if ($statusCode -eq 401) { $webReady = $true }
  }
  $servicesReady = $true
  foreach ($service in @('analyze', 'clip', 'render')) {
    foreach ($index in 1..3) {
      $instance = "$service-$index"
      if (-not (Test-TrackedProcess (Join-Path $dataRoot "service-heartbeats\$service-$instance.json") "worker\service-supervisor.mjs*--service=$service*--instance=$instance")) {
        $servicesReady = $false
      }
    }
  }
  if ($webReady -and $servicesReady) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

if (-not $webReady -or -not $servicesReady) { throw 'Cutflow failed its startup health check. See logs\*.stderr.log.' }
Write-Host 'GC Cutflow is ready: http://localhost:3001/' -ForegroundColor Green
if (-not $NoBrowser) { Start-Process 'http://localhost:3001/' | Out-Null }
