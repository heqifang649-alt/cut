$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$root = 'D:\CUT-Releases\20261027-multisource-r1'
$line = [IO.File]::ReadAllLines((Join-Path $root '.env.local')) |
  Where-Object { $_ -match '^LIBTV_BRIDGE_TOKEN=' } |
  Select-Object -First 1
if (-not $line) { throw 'LIBTV_BRIDGE_TOKEN is not configured' }
$token = ($line -split '=', 2)[1]
$headers = @{ Authorization = "Bearer $token" }

function Invoke-Probe([string]$method, [string]$uri, [string]$body = '') {
  $client = [Net.Http.HttpClient]::new()
  try {
    $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($method), $uri)
    if ($body) { $request.Content = [Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json') }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [ordered]@{ method = $method; status = [int]$response.StatusCode; contentType = [string]$response.Content.Headers.ContentType; body = $content }
  } finally {
    $client.Dispose()
  }
}

$id = [Guid]::NewGuid().ToString()
$results = @(
  Invoke-Probe 'GET' "http://127.0.0.1:3001/api/integrations/libtv-multisource/$id"
  Invoke-Probe 'POST' 'http://127.0.0.1:3001/api/integrations/libtv-multisource' '{}'
  Invoke-Probe 'GET' "http://127.0.0.1:3001/api/integrations/libtv/$id"
)
$results | ConvertTo-Json -Depth 5
