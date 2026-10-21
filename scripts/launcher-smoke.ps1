$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "start-roast-room.ps1"
$roomPort = 4740
$foreignPort = 4741
$roomPid = $null
$foreign = $null
$tempServer = Join-Path ([IO.Path]::GetTempPath()) "roast-room-foreign-port-smoke.js"

try {
  & $launcher -Port $roomPort -NoBrowser
  $roomPid = (Get-NetTCPConnection -LocalPort $roomPort -State Listen | Select-Object -First 1).OwningProcess
  & $launcher -Port $roomPort -NoBrowser
  $roomPid2 = (Get-NetTCPConnection -LocalPort $roomPort -State Listen | Select-Object -First 1).OwningProcess
  if ($roomPid -ne $roomPid2) { throw "Launcher was not idempotent on port $roomPort." }
  $health = Invoke-RestMethod "http://127.0.0.1:$roomPort/api/seats" -TimeoutSec 3
  if ($health.seats.Count -ne 7) { throw "Launcher health check returned an unexpected seat count." }

  Set-Content -Path $tempServer -Encoding UTF8 -Value "require('http').createServer((q,r)=>r.end('foreign')).listen($foreignPort,'127.0.0.1');"
  $foreign = Start-Process -FilePath node -ArgumentList $tempServer -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700
  $guarded = $false
  try { & $launcher -Port $foreignPort -NoBrowser }
  catch { $guarded = $_.Exception.Message -like "*not Roast Room*" }
  if (-not $guarded) { throw "Launcher did not reject a foreign process on port $foreignPort." }

  Write-Host "Launcher smoke OK: start, reuse, health check, and foreign-port guard all pass"
} finally {
  if ($roomPid) { Stop-Process -Id $roomPid -Force -ErrorAction SilentlyContinue }
  if ($foreign -and -not $foreign.HasExited) { Stop-Process -Id $foreign.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $tempServer -Force -ErrorAction SilentlyContinue
}
