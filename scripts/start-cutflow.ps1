param(
  [switch]$NoBrowser,
  [switch]$SkipAccountCheck,
  [switch]$ControlA,
  [switch]$NoClaim
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
# Start-Process also builds a case-insensitive environment dictionary. Remove
# duplicate proxy key variants before any child process is launched.
foreach ($proxyName in @('HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy')) {
  [Environment]::SetEnvironmentVariable($proxyName, $null, 'Process')
}
foreach ($proxyName in @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
  $proxyValue = [Environment]::GetEnvironmentVariable($proxyName, 'User')
  if (-not $proxyValue) { $proxyValue = [Environment]::GetEnvironmentVariable($proxyName, 'Machine') }
  if ($proxyValue) { [Environment]::SetEnvironmentVariable($proxyName, $proxyValue, 'Process') }
}

# Node 22/24 在 Windows 11 24H2 上有 ncrypto::CSPRNG assert bug。
# --openssl-legacy-provider 绕过此 bug，crypto.randomBytes 测试通过。
$env:NODE_OPTIONS = '--openssl-legacy-provider'

$portalRoot = Split-Path -Parent $PSScriptRoot
# Runtime executable 与运行目录由 cutflow-runtime.json 唯一管理。其余启动调优项
#（例如最低剩余空间）仍可从 .env.local 读取；Web 与 Worker 都继承契约中的工作根。
$envFile = Join-Path $portalRoot '.env.local'
$script:cutflowEnvFileValues = @{}
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { continue }
    $script:cutflowEnvFileValues[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1).Trim()
  }
}
function Get-CutflowSetting([string]$name, [string]$current) {
  if ($current) { return $current }
  if ($script:cutflowEnvFileValues.ContainsKey($name)) { return $script:cutflowEnvFileValues[$name] }
  return $null
}
# 使用当前已安装的 Codex Node 运行时；上方 NODE_OPTIONS 规避 Windows
# 上的 ncrypto::CSPRNG 断言问题。
$runtimeFile = Join-Path $portalRoot 'config\cutflow-runtime.json'
if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) { throw "Runtime Contract not found: $runtimeFile" }
$runtime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runtime.schemaVersion -ne 3 -or -not $runtime.runtimeProfile -or -not $runtime.runtimeRevision) { throw 'Unsupported Cutflow Runtime Contract schema.' }
$providerConfigFile = Join-Path $portalRoot 'data\ai-provider-config.json'
if (-not (Test-Path -LiteralPath $providerConfigFile -PathType Leaf)) { throw "Provider config not found: $providerConfigFile" }
$providerConfig = Get-Content -LiteralPath $providerConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $providerConfig.fastModel -or -not $providerConfig.strongModel) { throw 'Provider fastModel and strongModel must be configured in data\ai-provider-config.json.' }
$runtimeNode = [string]$runtime.nodeExecutable
$runtimePython = [string]$runtime.pythonExecutable
if (-not $runtimeNode -or -not $runtimePython) { throw 'Runtime Contract must configure nodeExecutable and pythonExecutable.' }
$CodexHome = [string]$runtime.codexHome
$env:CUT_WORK_ROOT = [string]$runtime.workRoot
$env:DELIVERY_OUTPUT_DIR = [string]$runtime.deliveryRoot
if (-not $env:CUT_WORK_ROOT) { throw "CUT_WORK_ROOT is missing from $runtimeFile; the launcher never falls back to the project drive." }
$workSubdirectories = @('temp', 'proxy', 'cache', 'renders', 'intermediate', 'worker-scratch')
if (-not [System.IO.Path]::IsPathRooted($env:CUT_WORK_ROOT)) { throw "CUT_WORK_ROOT must be an absolute local path: $env:CUT_WORK_ROOT" }
if ($env:CUT_WORK_ROOT.StartsWith('\\')) { throw "CUT_WORK_ROOT must be a local disk path, not UNC/NAS: $env:CUT_WORK_ROOT" }
New-Item -ItemType Directory -Force -Path $env:CUT_WORK_ROOT | Out-Null
foreach ($name in $workSubdirectories) {
  $directory = Join-Path $env:CUT_WORK_ROOT $name
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $probe = Join-Path $directory ('.cutflow-write-probe-' + [Guid]::NewGuid().ToString('N'))
  try { [System.IO.File]::WriteAllText($probe, 'cutflow-work-root-probe'); Remove-Item -LiteralPath $probe -Force }
  catch { throw "CUT_WORK_ROOT subdirectory is not writable/deletable: $directory; $($_.Exception.Message)" }
}
$driveRoot = [System.IO.Path]::GetPathRoot($env:CUT_WORK_ROOT)
$drive = New-Object System.IO.DriveInfo($driveRoot)
$minimumFreeBytes = Get-CutflowSetting 'CUTFLOW_MIN_FREE_BYTES' $env:CUTFLOW_MIN_FREE_BYTES
if (-not $minimumFreeBytes) { throw "CUTFLOW_MIN_FREE_BYTES is not configured. Define it in $envFile (single source of truth)." }
$env:CUTFLOW_MIN_FREE_BYTES = "$minimumFreeBytes"
$minimumFreeBytes = [int64]$minimumFreeBytes
if ($drive.AvailableFreeSpace -lt $minimumFreeBytes) { throw ('CUT_WORK_ROOT free space is too low: {0:N2} GiB; minimum is {1:N2} GiB' -f ($drive.AvailableFreeSpace / 1GB), ($minimumFreeBytes / 1GB)) }
$logRoot = Join-Path $env:CUT_WORK_ROOT 'worker-scratch\logs'
$dataRoot = Join-Path $portalRoot 'data'

if (-not (Test-Path -LiteralPath $runtimeNode -PathType Leaf)) { throw "Node runtime not found: $runtimeNode" }
if (-not (& $runtimeNode --version 2>$null)) { throw 'RUNTIME_DEPENDENCY_UNAVAILABLE: node --version' }
foreach ($requiredScript in @('node_modules\next\dist\bin\next', 'worker\runtime-config.mjs', 'worker\runtime-preflight.mjs', 'worker\fleet-supervisor.mjs', 'worker\service-supervisor.mjs', 'worker\service-runner.mjs', 'worker\auxiliary-supervisor.mjs', 'worker\processor.mjs', 'worker\batch-renderer.mjs', 'worker\template-processor.mjs', 'worker\delivery-watcher.mjs', 'worker\chatcut-sync.mjs', 'worker\render-overlays.py')) {
  if (-not (Test-Path -LiteralPath (Join-Path $portalRoot $requiredScript) -PathType Leaf)) { throw "RUNTIME_DEPENDENCY_UNAVAILABLE: script:$requiredScript" }
}
& $runtimeNode (Join-Path $portalRoot 'worker\runtime-preflight.mjs') '--capability=web'
if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_DEPENDENCY_UNAVAILABLE: web preflight failed; see data\runtime-health\web.json' }
New-Item -ItemType Directory -Force -Path $logRoot, $dataRoot | Out-Null
$workerTempRoot = [string]$runtime.runtimeTempRoot
$workerCacheRoot = Join-Path ([string]$runtime.runtimeCacheRoot) 'workers'
New-Item -ItemType Directory -Force -Path $workerTempRoot, $workerCacheRoot | Out-Null
$env:CUTFLOW_WORKER_TEMP_ROOT = $workerTempRoot
$env:CUTFLOW_WORKER_CACHE_ROOT = $workerCacheRoot
$bootstrapTemp = Join-Path $workerTempRoot 'bootstrap'
$bootstrapCache = Join-Path $workerCacheRoot 'bootstrap'
New-Item -ItemType Directory -Force -Path $bootstrapTemp, $bootstrapCache | Out-Null

if ($CodexHome) { $env:CODEX_HOME = $CodexHome }
else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
if ($CodexHome -and $runtime.codexCliExecutable) { $env:CODEX_CLI_PATH = [string]$runtime.codexCliExecutable }
else { Remove-Item Env:CODEX_CLI_PATH -ErrorAction SilentlyContinue }
$env:XDG_CACHE_HOME = [string]$runtime.runtimeCacheRoot
$env:TEMP = $bootstrapTemp
$env:TMP = $bootstrapTemp
$env:TMPDIR = $bootstrapTemp
$env:XDG_CACHE_HOME = $bootstrapCache

# Normal startup processes production queue work. Use -NoClaim for maintenance;
# the saved .env.local value is the durable policy and a per-process false
# cannot silently put an ordinary restart back into maintenance mode.
$claimSetting = Get-CutflowSetting 'CUTFLOW_CLAIM_ENABLED' $null
if (-not $claimSetting) { $claimSetting = $env:CUTFLOW_CLAIM_ENABLED }
if ($NoClaim) { $claimSetting = 'false' }
if (-not $claimSetting) { $claimSetting = 'true' }
$env:CUTFLOW_CLAIM_ENABLED = if ($claimSetting -eq 'false') { 'false' } else { 'true' }

function Convert-CodePoints([int[]]$Codes) {
  return -join ($Codes | ForEach-Object { [char]$_ })
}

$creativeDepartment = Convert-CodePoints @(20869, 23481, 21019, 24847, 37096)
$adDelivery = Convert-CodePoints @(24191, 21578, 25104, 29255, 20132, 20184)
$newDelivery = Convert-CodePoints @(26032, 25104, 29255, 20132, 20184)
$finishedVideos = Convert-CodePoints @(25104, 29255)

$env:ALLOWED_NAS_ROOTS = "\\192.168.120.60\$creativeDepartment-fb$adDelivery;\\192.168.120.60\$newDelivery"
$env:GOLD_STANDARD_PATH = Join-Path $portalRoot 'standards\reference-sets\gc-good-20260805\gold-standard-v2.json'
$env:PYTHONPATH = Join-Path (Split-Path -Parent $runtimePython) 'Lib\site-packages'

# G3-authorized production default. -ControlA is the one-command rollback;
# it preserves the website, queues and workers while disabling the Hybrid path.
$hybridFlags = @(
  'ENABLE_NEW_VALIDATOR',
  'ENABLE_NEW_SHOTPOOL',
  'ENABLE_NEW_SCHEDULER',
  'ENABLE_NEW_RENDERER',
  'ENABLE_API_SEMANTIC_SCORER',
  'ENABLE_HYBRID_PILOT'
)
foreach ($flag in $hybridFlags) {
  [Environment]::SetEnvironmentVariable($flag, $(if ($ControlA) { 'false' } else { 'true' }), 'Process')
}
$env:ENABLE_ARTIFACT_GATE = 'false'
$env:MODEL_FAST = [string]$providerConfig.fastModel
$env:MODEL_STRONG = [string]$providerConfig.strongModel
if ($ControlA) {
  Write-Host 'Cutflow production path: Control A rollback mode.' -ForegroundColor Yellow
} else {
  Write-Host "Cutflow production path: Hybrid deterministic default ($($providerConfig.fastModel))." -ForegroundColor Green
}
$productionPathState = @{
  schemaVersion = 1
  mode = if ($ControlA) { 'control_a' } else { 'hybrid' }
  controlA = [bool]$ControlA
  modelFast = $env:MODEL_FAST
  modelStrong = $env:MODEL_STRONG
  artifactGate = $false
  flags = @{}
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
foreach ($flag in $hybridFlags) { $productionPathState.flags[$flag] = [Environment]::GetEnvironmentVariable($flag, 'Process') }
[System.IO.File]::WriteAllText(
  (Join-Path $dataRoot 'production-path.json'),
  ($productionPathState | ConvertTo-Json -Depth 4),
  [System.Text.UTF8Encoding]::new($false)
)

$codexReady = $false
$codexResponse = ''
$codexApiReady = $false
$codexExecutorReady = $false
$codexAuthenticationValid = $null
$codexStatus = 'unresponsive'
$codexFailureClass = 'service_unavailable'
$accountStatePath = Join-Path $dataRoot 'codex-account-state.json'
$previousAccountState = $null
if (-not $CodexHome) {
  $codexResponse = 'Runtime Contract 中未配置 Codex Home；Codex 依赖任务保持不可用，非 Codex Worker 继续运行'
  $codexStatus = 'unconfigured'
  $codexFailureClass = 'service_unavailable'
} elseif ($SkipAccountCheck) {
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
  # The probe performs a bounded model check followed by a bounded executor
  # check. Its own default budget is 30s + 45s, so a 20s launcher cutoff
  # always kills a healthy-but-slow executor and persists a false outage.
  $configuredProbeBudget = 0
  try { $configuredProbeBudget = [int]$env:CUTFLOW_ACCOUNT_PROBE_TIMEOUT_SECONDS } catch { $configuredProbeBudget = 0 }
  if ($configuredProbeBudget -lt 90) { $configuredProbeBudget = 90 }
  $probeBudgetSeconds = $configuredProbeBudget
  $cutoff = (Get-Date).AddSeconds($probeBudgetSeconds)
  $capture = $null
  $probeExitCode = $null
  do {
    $probeId = [guid]::NewGuid().ToString()
    $probeOutput = Join-Path $logRoot "codex-probe-$probeId.stdout.log"
    $probeError = Join-Path $logRoot "codex-probe-$probeId.stderr.log"
    $probeProcess = $null
    try {
      $probeProcess = Start-Process -FilePath $runtimeNode -ArgumentList @((Join-Path $portalRoot 'scripts\check-codex.mjs')) -WorkingDirectory $portalRoot -RedirectStandardOutput $probeOutput -RedirectStandardError $probeError -WindowStyle Hidden -PassThru
      while (-not $probeProcess.HasExited -and (Get-Date) -lt $cutoff) { Start-Sleep -Milliseconds 250; $probeProcess.Refresh() }
      if (-not $probeProcess.HasExited) {
        # The probe's own Abort signal protects normal SDK work. This outer
        # process-tree termination is the final guard when a Node process is
        # wedged before it can observe that signal.
        & taskkill.exe /PID $probeProcess.Id /T /F | Out-Null
        $probeExitCode = -1
      } else {
        $probeExitCode = $probeProcess.ExitCode
      }
      $capture = ((Get-Content -LiteralPath $probeOutput -Raw -ErrorAction SilentlyContinue), (Get-Content -LiteralPath $probeError -Raw -ErrorAction SilentlyContinue) | Where-Object { $_ }) -join "`n"
    } catch {
      $capture = $_.Exception.Message
      $probeExitCode = -1
    } finally {
      Remove-Item -LiteralPath $probeOutput, $probeError -Force -ErrorAction SilentlyContinue
    }
    # A healthy probe can emit its JSON result just before the outer process
    # guard reaps a lingering child. Keep and parse that result even when the
    # wrapper observes exit code -1.
    if ($capture) { break }
    if ((Get-Date) -ge $cutoff) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $cutoff)
  if ($capture) {
    try {
      $check = $capture | ConvertFrom-Json
      $codexReady = [bool]$check.ready
      $codexApiReady = [bool]$check.apiReady
      $codexExecutorReady = [bool]$check.executorReady
      $codexAuthenticationValid = if ($null -eq $check.authenticationValid) { $null } else { [bool]$check.authenticationValid }
      $codexStatus = if ($check.status) { [string]$check.status } elseif ($codexReady) { 'normal' } elseif ($codexApiReady) { 'unresponsive' } else { 'unresponsive' }
      $codexFailureClass = if ($check.failureClass) { [string]$check.failureClass } elseif ($codexReady) { 'healthy' } elseif ($codexAuthenticationValid -eq $false) { 'auth_failed' } elseif ($codexApiReady) { 'executor_stalled' } else { 'service_unavailable' }
      $codexResponse = [string]$check.response
    } catch { $codexResponse = "解析失败: $capture" }
  } else {
    $codexResponse = if ($capture) { "exit=$probeExitCode out=$capture" } else { 'check-codex 超时' }
  }
}

if (-not $SkipAccountCheck -or -not $CodexHome) {
  $accountState = @{
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    codexHome = $CodexHome
    ready = $codexReady
    apiReady = $codexApiReady
    executorReady = $codexExecutorReady
    authenticationValid = $codexAuthenticationValid
    status = $codexStatus
    failureClass = $codexFailureClass
    response = $codexResponse
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($accountStatePath, $accountState, [System.Text.UTF8Encoding]::new($false))
}

if ($codexReady) {
  Write-Host 'Codex 账号连接正常。' -ForegroundColor Green
} elseif ($codexAuthenticationValid -eq $false) {
  Write-Host "Codex 账号认证失效，Codex 任务将等待重新连接。原因：$codexResponse" -ForegroundColor Yellow
} elseif ($codexApiReady) {
  Write-Host "Codex 模型服务可达，但执行器暂时无响应；Codex 任务会自动恢复，非 Codex 任务继续运行。原因：$codexResponse" -ForegroundColor Yellow
} else {
  Write-Host "Codex 连接暂时不可用，Codex 任务将退避重试。原因：$codexResponse" -ForegroundColor Yellow
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
  # 不用 -UseNewEnvironment：worker 需要继承 NODE_OPTIONS、Runtime Contract
  # 的 Codex Home（仅已配置时）和 NAS allowlist 等进程环境。
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
if ($NoClaim -and $listener) {
  throw 'No-Claim requires restart-cutflow.ps1 -NoClaim while Web is already running; the existing Web watchdog may relaunch a claims-enabled Fleet.'
}
if (-not $listener) {
  $nextCli = Join-Path $portalRoot 'node_modules\next\dist\bin\next'
  Start-Process -FilePath $runtimeNode -ArgumentList @($nextCli, 'start', '-p', '3001', '-H', '0.0.0.0') `
    -WorkingDirectory $portalRoot -RedirectStandardOutput (Join-Path $logRoot 'web.stdout.log') `
    -RedirectStandardError (Join-Path $logRoot 'web.stderr.log') -WindowStyle Hidden | Out-Null
} else {
  $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($webProcess.CommandLine -notlike '*next*start*-p*3001*') { throw "Port 3001 is occupied by PID $($listener.OwningProcess)" }
}

# The fleet supervisor is the persistent parent of every stage/auxiliary
# supervisor. If any supervisor exits, it is recreated without requiring the
# launcher or a user session to remain open.
$fleetArguments = @('worker\fleet-supervisor.mjs')
if ($NoClaim) { $fleetArguments += '--no-claim' }
Start-Worker 'fleet-supervisor' $fleetArguments (Join-Path $dataRoot 'fleet-runtime.json') 'worker\fleet-supervisor.mjs'

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
  $servicesReady = Test-TrackedProcess (Join-Path $dataRoot 'fleet-runtime.json') 'worker\fleet-supervisor.mjs'
  foreach ($service in @('analyze', 'clip', 'render')) {
    foreach ($index in 1..3) {
      $instance = "$service-$index"
      if (-not (Test-TrackedProcess (Join-Path $dataRoot "service-heartbeats\$service-$instance.json") "worker\service-supervisor.mjs*--service=$service*--instance=$instance")) {
        $servicesReady = $false
      }
    }
  }
  foreach ($auxiliary in @('template', 'delivery', 'chatcut')) {
    if (-not (Test-TrackedProcess (Join-Path $dataRoot "auxiliary-runtime\$auxiliary.json") "worker\auxiliary-supervisor.mjs*--worker=$auxiliary")) {
      $servicesReady = $false
    }
  }
  if ($webReady -and $servicesReady) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

if (-not $webReady -or -not $servicesReady) { throw 'Cutflow failed its startup health check. See logs\*.stderr.log.' }
if ($NoClaim) {
  $fleetRuntime = Get-Content -LiteralPath (Join-Path $dataRoot 'fleet-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($fleetRuntime.claimsEnabled -ne $false) { throw 'No-Claim Fleet Gate failed: Fleet is claims-enabled.' }
  foreach ($service in @('analyze', 'clip', 'render')) {
    foreach ($index in 1..3) {
      $instance = "$service-$index"
      $heartbeat = Get-Content -LiteralPath (Join-Path $dataRoot "service-heartbeats\$service-$instance.json") -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($heartbeat.claimsEnabled -ne $false) { throw "No-Claim Fleet Gate failed: $instance is claims-enabled." }
    }
  }
}
if (-not $NoBrowser) {
  . (Join-Path $PSScriptRoot 'cutflow-lan-url.ps1')
  $lanUrl = Get-CutflowLanUrl
  Write-Host "GC Cutflow is ready: $lanUrl" -ForegroundColor Green
  Start-Process $lanUrl | Out-Null
} else {
  Write-Host 'GC Cutflow web and workers are ready.' -ForegroundColor Green
}
