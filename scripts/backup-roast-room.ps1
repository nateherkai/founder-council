param(
  [string]$Destination,
  [switch]$IncludeEnv
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $repo "backups" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $Destination "roast-room-$stamp"
New-Item -ItemType Directory -Force -Path $target | Out-Null

$bundle = Join-Path $target "repo.bundle"
& git -C $repo bundle create $bundle --all
if ($LASTEXITCODE -ne 0) { throw "git bundle create failed" }
$git = (Get-Command git -ErrorAction Stop).Source
$verifyOut = Join-Path $target "bundle-verify.out"
$verifyErr = Join-Path $target "bundle-verify.err"
$verify = Start-Process -FilePath $git -ArgumentList @("-C", $repo, "bundle", "verify", $bundle) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $verifyOut -RedirectStandardError $verifyErr
if ($verify.ExitCode -ne 0) {
  $detail = if (Test-Path $verifyErr) { (Get-Content $verifyErr -Raw) } else { "" }
  throw "git bundle verify failed: $detail"
}
Remove-Item $verifyOut, $verifyErr -Force -ErrorAction SilentlyContinue

$sessionsDir = Join-Path $repo "sessions"
$sessionsZip = Join-Path $target "sessions.zip"
if (Test-Path $sessionsDir) {
  Compress-Archive -Path (Join-Path $sessionsDir "*") -DestinationPath $sessionsZip -CompressionLevel Optimal -Force
}

$envIncluded = $false
if ($IncludeEnv -and (Test-Path (Join-Path $repo ".env"))) {
  Copy-Item (Join-Path $repo ".env") (Join-Path $target ".env") -Force
  $envIncluded = $true
}

$head = (& git -C $repo rev-parse HEAD).Trim()
$branch = (& git -C $repo branch --show-current).Trim()
$sessionCount = @(Get-ChildItem $sessionsDir -Directory -ErrorAction SilentlyContinue).Count
$manifest = [ordered]@{
  created_at = (Get-Date).ToString("o")
  head = $head
  branch = $branch
  sessions = $sessionCount
  env_included = $envIncluded
  repo_bundle = "repo.bundle"
  sessions_archive = if (Test-Path $sessionsZip) { "sessions.zip" } else { $null }
}
$manifest | ConvertTo-Json | Set-Content (Join-Path $target "manifest.json") -Encoding UTF8

@"
Roast Room backup

Restore code into a new folder:
  git clone repo.bundle roast-room

Then extract sessions.zip into the restored repo's sessions folder.
If .env was intentionally included, copy it into the repo root after restore.
"@ | Set-Content (Join-Path $target "RESTORE.txt") -Encoding UTF8

Write-Output $target
