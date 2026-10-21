$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$updater = Join-Path $root 'tools\one-click-updater\RUN-ME.ps1'
if (-not (Test-Path $updater)) { throw 'Tracked updater source is missing.' }

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($updater, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Updater PowerShell syntax errors: $($parseErrors -join '; ')" }

$source = Get-Content -LiteralPath $updater -Raw
if ($source -notmatch '\$expectedHead\s*=\s*\(& git rev-parse \$ExpectedBaseCommit\)\.Trim\(\)') {
    throw 'Updater must resolve the expected short commit to a full commit before comparison.'
}
if ($source -match 'rev-parse --short HEAD\)\.Trim\(\).*\$ExpectedBaseCommit') {
    throw 'Updater regressed to direct short/full SHA comparison.'
}
if ($source -notmatch '\$existingBranches\s*=\s*@\(& git branch --list \$Branch\)') {
    throw 'Updater branch-existence check is not null-safe.'
}
if ($source -match '\[string\].*git branch --list.*\.Trim\(\)') {
    throw 'Updater regressed to Trim() on possibly empty branch-list output.'
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("roast-room-updater-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    Push-Location $temp
    git init -q
    git config user.email 'ci@example.invalid'
    git config user.name 'Roast Room CI'
    Set-Content -LiteralPath (Join-Path $temp 'fixture.txt') -Value 'fixture'
    git add fixture.txt
    git commit -q -m fixture

    $short = (& git rev-parse --short HEAD).Trim()
    $head = (& git rev-parse HEAD).Trim()
    $expectedHead = (& git rev-parse $short).Trim()
    if ($head -ne $expectedHead) { throw 'Short SHA did not resolve to the exact full commit.' }

    $existingBranches = @(& git branch --list '__definitely_missing_branch__')
    if ($existingBranches.Count -ne 0) { throw 'Missing branch unexpectedly returned output.' }
} finally {
    Pop-Location
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Updater helper smoke OK: full-SHA comparison and null-safe branch lookup pass'
