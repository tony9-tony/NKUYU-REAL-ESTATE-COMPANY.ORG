# Stops whatever process is listening on a port, so a rebuilt server can be
# started in its place. Used only for the local dev server during development.
param([int]$Port = 3003)

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Output "nothing is listening on port $Port"
  exit 0
}
foreach ($listener in $listeners) {
  $pid_ = $listener.OwningProcess
  Write-Output "stopping PID $pid_ on port $Port"
  Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Output "port $Port is still occupied"
  exit 1
}
Write-Output "port $Port is free"
