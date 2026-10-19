$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$port = 4730
$url = "http://localhost:$port"

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm start" -WorkingDirectory $repo -WindowStyle Minimized
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest "$url/api/seats" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { throw "Roast Room did not become ready on port $port." }
}

Start-Process $url
