# RUN-ME.ps1
$ErrorActionPreference = "Stop"

$ExpectedRemoteFragment = "pouranj/roast-room"
$ExpectedBaseCommit = "bc17b39"
$Branch = "feat/hybrid-reliability-v2"
$PatchFile = Join-Path $PSScriptRoot "roast-room-reliability-ed64d08.patch"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Test-RoastRepo([string]$Path) {
    if (-not $Path -or -not (Test-Path $Path)) { return $false }
    if (-not (Test-Path (Join-Path $Path ".git"))) { return $false }
    Push-Location $Path
    try {
        $remote = (& git remote get-url origin 2>$null)
        if ($LASTEXITCODE -ne 0) { return $false }
        return ($remote -like "*$ExpectedRemoteFragment*")
    } finally {
        Pop-Location
    }
}

function Get-ShortcutCandidates {
    $results = New-Object System.Collections.Generic.List[string]
    $desktopPaths = @(
        [Environment]::GetFolderPath("Desktop"),
        (Join-Path $env:USERPROFILE "OneDrive\Desktop")
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

    $shell = New-Object -ComObject WScript.Shell
    foreach ($desktop in $desktopPaths) {
        Get-ChildItem $desktop -Filter "*.lnk" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "Roast.*Room|RoastRoom" } |
            ForEach-Object {
                try {
                    $shortcut = $shell.CreateShortcut($_.FullName)
                    if ($shortcut.WorkingDirectory) { $results.Add($shortcut.WorkingDirectory) }
                    if ($shortcut.TargetPath) {
                        $results.Add((Split-Path $shortcut.TargetPath -Parent))
                    }
                } catch {}
            }
    }
    return $results
}

function Find-RoastRepo {
    Write-Step "Finding your Roast Room project automatically"

    foreach ($candidate in (Get-ShortcutCandidates)) {
        if (Test-RoastRepo $candidate) { return (Resolve-Path $candidate).Path }
    }

    $roots = @(
        (Join-Path $env:USERPROFILE "Desktop"),
        (Join-Path $env:USERPROFILE "Documents"),
        (Join-Path $env:USERPROFILE "Downloads"),
        (Join-Path $env:USERPROFILE "source"),
        (Join-Path $env:USERPROFILE "repos"),
        (Join-Path $env:USERPROFILE "projects"),
        (Join-Path $env:USERPROFILE "OneDrive\Desktop"),
        (Join-Path $env:USERPROFILE "OneDrive\Documents")
    ) | Where-Object { Test-Path $_ } | Select-Object -Unique

    foreach ($root in $roots) {
        $dirs = Get-ChildItem $root -Directory -Recurse -Depth 4 -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "roast-room" -or $_.Name -like "*roast*room*" }
        foreach ($dir in $dirs) {
            if (Test-RoastRepo $dir.FullName) { return $dir.FullName }
        }
    }

    return $null
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git was not found. Roast Room previously used Git, so please reinstall/open Git for Windows first."
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js was not found."
    }
    if (-not (Test-Path $PatchFile)) {
        throw "The patch file is missing from this folder."
    }

    $repo = Find-RoastRepo
    if (-not $repo) {
        Write-Host ""
        Write-Host "I could not find Roast Room automatically." -ForegroundColor Yellow
        Write-Host "Nothing was changed."
        Write-Host "Send ChatGPT a screenshot of this window."
        Read-Host "Press Enter to close"
        exit 2
    }

    Write-Host "Found Roast Room at:" -ForegroundColor Green
    Write-Host $repo

    Set-Location $repo

    Write-Step "Safety checks"
    $remote = (& git remote get-url origin).Trim()
    if ($remote -notlike "*$ExpectedRemoteFragment*") {
        throw "The Git remote is not the expected Roast Room repository: $remote"
    }

    $status = (& git status --porcelain)
    if ($status) {
        throw "The project has local uncommitted changes. Nothing was changed. Send ChatGPT a screenshot."
    }

    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $head) { throw "Could not resolve the current commit." }
    $expectedHead = (& git rev-parse $ExpectedBaseCommit).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $expectedHead) { throw "Could not resolve expected baseline $ExpectedBaseCommit." }
    Write-Host "Current commit: $($head.Substring(0, [Math]::Min(7, $head.Length)))"

    if ($head -ne $expectedHead) {
        Write-Host "Your project is on a different commit than the tested baseline." -ForegroundColor Yellow
        throw "Expected $ExpectedBaseCommit ($expectedHead) but found $head. Nothing was changed."
    }

    Write-Step "Creating a local safety branch"
    & git branch "backup/before-reliability-$((Get-Date).ToString('yyyyMMdd-HHmmss'))" $head
    if ($LASTEXITCODE -ne 0) { throw "Could not create the safety branch." }

    $existingBranches = @(& git branch --list $Branch)
    if ($existingBranches.Count -gt 0) {
        $Branch = "feat/hybrid-reliability-v2-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
        Write-Host "The default reliability branch already exists; using: $Branch" -ForegroundColor Yellow
    }

    & git switch -c $Branch
    if ($LASTEXITCODE -ne 0) { throw "Could not create $Branch." }

    Write-Step "Checking and applying the tested patch"
    & git apply --check $PatchFile
    if ($LASTEXITCODE -ne 0) { throw "Patch validation failed. No patch was applied." }

    & git apply $PatchFile
    if ($LASTEXITCODE -ne 0) { throw "Patch application failed." }

    Write-Step "Running Roast Room verification"
    $tests = @(
        @("npm", @("run", "check")),
        @("npm", @("run", "ci:smoke")),
        @("npm", @("run", "resume:smoke")),
        @("npm", @("run", "crash:resume:smoke")),
        @("npm", @("run", "telemetry:smoke")),
        @("npm", @("run", "retry:smoke")),
        @("npm", @("run", "hybrid:server:smoke"))
    )

    foreach ($test in $tests) {
        $exe = $test[0]
        $args = $test[1]
        Write-Host ""
        Write-Host "> $exe $($args -join ' ')" -ForegroundColor DarkCyan
        & $exe @args
        if ($LASTEXITCODE -ne 0) {
            throw "A verification test failed: $exe $($args -join ' ')"
        }
    }

    Write-Step "Committing the verified update"
    & git add README.md app hybrid package.json scripts .github
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }

    & git commit -m "Harden Hybrid recovery, telemetry, and retries"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed." }

    $newCommit = (& git rev-parse --short HEAD).Trim()
    Write-Host "Created commit: $newCommit" -ForegroundColor Green

    Write-Step "Pushing the feature branch to GitHub"
    & git push -u origin $Branch
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "The update is installed and committed locally, but GitHub push did not complete." -ForegroundColor Yellow
        Write-Host "Nothing needs to be undone. Send ChatGPT a screenshot of this window."
        Read-Host "Press Enter to close"
        exit 3
    }

    Write-Host ""
    Write-Host "SUCCESS" -ForegroundColor Green
    Write-Host "Roast Room was updated, tested, committed, and pushed to GitHub."
    Write-Host "Branch: $Branch"
    Write-Host "Commit: $newCommit"
    Write-Host ""
    Write-Host "Send ChatGPT a screenshot of this SUCCESS screen so it can verify GitHub Actions."
    Read-Host "Press Enter to close"
}
catch {
    Write-Host ""
    Write-Host "STOPPED SAFELY" -ForegroundColor Red
    Write-Host $_.Exception.Message
    Write-Host ""
    Write-Host "No force-push was used. Send ChatGPT a screenshot of this window."
    Read-Host "Press Enter to close"
    exit 1
}
