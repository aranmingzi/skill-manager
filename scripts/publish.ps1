#requires -version 5.1
<#
    Publish skill-manager to GitHub.

    One-time setup:
        gh auth login

    Then, from anywhere:

        # Windows PowerShell (works on a stock Windows box)
        powershell -ExecutionPolicy Bypass -File scripts\publish.ps1

        # PowerShell 7, if installed
        pwsh scripts/publish.ps1

    Options:
        -Name other-repo   different repository name
        -Private           private repository

    The script is idempotent: it fills the OWNER placeholder with your GitHub
    login, commits anything outstanding, creates the repository if it does not
    exist yet, then pushes. Re-running it after edits is safe.

    Keep this file ASCII-only: Windows PowerShell 5.1 reads scripts as ANSI
    unless they carry a UTF-8 BOM, so non-ASCII text here breaks on a stock box.
#>
[CmdletBinding()]
param(
    [string]$Name = 'skill-manager',
    [switch]$Private
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

# .NET file APIs resolve relative paths against the process working directory,
# not PowerShell's location, so always use absolute paths here.
function Write-TextFile([string]$path, [string]$text) {
    # Set-Content in Windows PowerShell 5.1 writes a BOM, which breaks JSON.
    [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not on PATH.' }
if (-not (Get-Command gh  -ErrorAction SilentlyContinue)) { Fail 'gh (GitHub CLI) is not on PATH.' }

# Native stderr becomes an error record, which a Stop policy treats as
# terminating; 2>$null keeps the probe quiet and exit-code driven.
# Native stderr becomes an error record, which a Stop policy treats as
# terminating (gh writes "not logged in" to stderr), so probes run with a
# Continue policy and are judged purely by exit code.
function Invoke-Native([string]$exe, [string[]]$arguments) {
    $pref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $exe @arguments 2>$null
        $code = $LASTEXITCODE
        return [pscustomobject]@{ code = $code; output = ($output | Out-String).Trim() }
    } finally {
        $ErrorActionPreference = $pref
    }
}

# Probe with a real API call rather than `gh auth status`: status reads the
# OS keyring and reports "token in keyring is invalid" in non-interactive
# shells (and misreports proxy failures as bad tokens), while an authenticated
# API call is exactly the capability this script needs.
$login = (Invoke-Native 'gh' @('api', 'user', '--jq', '.login')).output
if ([string]::IsNullOrWhiteSpace($login) -or $login -match '\s') {
    Write-Host 'GitHub CLI is not logged in, or the network cannot reach api.github.com.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'One-time login:' -ForegroundColor Yellow
    Write-Host '    gh auth login' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'If you normally reach GitHub through a proxy, make sure it is running;' -ForegroundColor Yellow
    Write-Host 'if the machine reaches GitHub directly, clear a stale proxy first:' -ForegroundColor Yellow
    Write-Host '    $env:HTTPS_PROXY=""; $env:HTTP_PROXY=""' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'Then run this script from its own directory:' -ForegroundColor Yellow
    Write-Host '    cd <path to this repo>; powershell -ExecutionPolicy Bypass -File scripts\publish.ps1' -ForegroundColor Cyan
    exit 2
}

Write-Host "GitHub account: $login" -ForegroundColor Green

Push-Location $root
try {
    # 1. Fill the OWNER placeholder wherever it is still a placeholder.
    foreach ($file in @('package.json', 'README.md', 'README.zh-CN.md')) {
        $path = Join-Path $root $file
        if (-not (Test-Path $path)) { continue }
        $text = [System.IO.File]::ReadAllText($path)
        if ($text -notmatch 'OWNER') { continue }
        Write-TextFile $path ($text -replace 'OWNER', $login)
        Write-Host "  filled $file" -ForegroundColor DarkGray
    }

    # 2. Repo + identity. The noreply address is only used when git has nothing
    #    configured, so a real global identity is never overwritten.
    if (-not (Test-Path (Join-Path $root '.git'))) {
        git init -b main | Out-Null
        Write-Host '  git init' -ForegroundColor DarkGray
    }
    if (-not (Invoke-Native 'git' @('config', 'user.name')).output) { git config user.name  $login }
    if (-not (Invoke-Native 'git' @('config', 'user.email')).output) { git config user.email "$login@users.noreply.github.com" }

    # 3. Commit outstanding work, if any.
    git add -A
    $staged = @(git diff --cached --name-only)
    if ($staged.Count -gt 0) {
        git commit -m "Release $Name" | Out-Null
        Write-Host "  committed $($staged.Count) file(s)" -ForegroundColor DarkGray
    } else {
        Write-Host '  nothing to commit' -ForegroundColor DarkGray
    }

    # 4. Create the remote (once) and push.
    $repoExists = (Invoke-Native 'gh' @('repo', 'view', "$login/$Name")).code -eq 0
    if (-not $repoExists) {
        $visibility = if ($Private) { '--private' } else { '--public' }
        gh repo create $Name $visibility --source=. --remote=origin --push --description 'Rank installed skills against the current request, gate irrelevant skill loads, keep a per-skill usage ledger. A DeepSeek Harness host plugin.'
        if ($LASTEXITCODE -ne 0) { Fail 'gh repo create failed; see the output above.' }
        gh repo edit --add-topic dsh --add-topic deepseek-harness --add-topic plugin --add-topic skills --add-topic agent 2>$null | Out-Null
    } else {
        $remote = (Invoke-Native 'git' @('remote', 'get-url', 'origin')).output
        if (-not $remote) { git remote add origin "https://github.com/$login/$Name.git" }
        git push -u origin main
        if ($LASTEXITCODE -ne 0) { Fail 'git push failed; see the output above.' }
    }

    Write-Host ''
    Write-Host "Done: https://github.com/$login/$Name" -ForegroundColor Green
    Write-Host 'Tag the release when you are happy with it:' -ForegroundColor Yellow
    Write-Host '    git tag v1.2.0 -m "1.2.0" ; git push --tags' -ForegroundColor Cyan
} finally {
    Pop-Location
}