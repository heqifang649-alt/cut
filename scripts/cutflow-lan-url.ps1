function Get-CutflowLanUrl {
  $address = Get-NetIPConfiguration | Where-Object {
    $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'
  } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object {
    $_ -and $_ -notlike '127.*' -and $_ -notlike '169.254.*'
  } | Select-Object -First 1
  if (-not $address) { throw 'No active LAN IPv4 address found.' }
  return "http://${address}:3001/"
}
