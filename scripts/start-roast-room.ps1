param(
  [int]$Port = 4730,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$apiUrl = "http://127.0.0.1:$Port"
$browserUrl = "http://localhost:$Port"
$logDir = Join-Path $repo ".chatgpt-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-RoastRoom {
  try {
    $data = Invoke-RestMethod "$apiUrl/api/seats" -TimeoutSec 2
    return ($null -ne $data.runner -and $data.seats.Count -eq 7)
  } catch { return $false }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  if (-not (Test-RoastRoom)) {
    $owner = $listener.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.Name } else { "PID $owner" }
    throw "Port $Port is already in use by $name, not Roast Room. Nothing was changed."
  }
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  $out = Join-Path $logDir "server-$Port.log"
  $err = Join-Path $logDir "server-$Port.err"
  $oldPort = $env:PORT
  try {
    $env:PORT = [string]$Port
    $server = Start-Process -FilePath $node -ArgumentList "app/server.mjs" -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  } finally {
    if ($null -eq $oldPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $oldPort }
  }
  Set-Content -Path (Join-Path $logDir "server-$Port.pid") -Value $server.Id
  if ($Port -eq 4730) { Set-Content -Path (Join-Path $logDir "server.pid") -Value $server.Id }

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-RoastRoom) { $ready = $true; break }
    if ($server.HasExited) { break }
  }
  if (-not $ready) {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    $tail = if (Test-Path $err) { (Get-Content $err -Tail 8 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
    throw "Roast Room did not become ready on port $Port. $tail"
  }
}

if (-not $NoBrowser) { Start-Process $browserUrl }
Write-Host "Roast Room ready: $browserUrl"
