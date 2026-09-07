<#
.SYNOPSIS
    Fails if any tracked file names a real server, share, or account.

.DESCRIPTION
    This repository is public, and much of what it does is talk to somebody's on-premises Azure
    DevOps Server. Every host, collection, project, and account name is therefore a runtime
    parameter, never a literal -- and this check exists so that stays true.

    The check is pattern-based rather than a list of forbidden names, deliberately: a blocklist of
    real host names committed to a public repository would publish exactly what it was meant to
    protect. Instead it flags anything that looks like an environment reference and is not on a
    short allowlist of public, documentation, and placeholder authorities.

    It flags:
      * absolute http(s) URLs whose authority is not allowlisted
      * UNC paths
      * DOMAIN\account literals for any domain other than the placeholder

.PARAMETER Path
    Repository root to check. Defaults to the parent of this script's directory.

.EXAMPLE
    .\Test-NoEnvironmentLeaks.ps1

.EXAMPLE
    .\Test-NoEnvironmentLeaks.ps1 -Verbose
#>
[CmdletBinding()]
param (
    [Parameter()]
    [string] $Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolved in the body rather than as a parameter default: $PSScriptRoot is not yet populated while
# parameter defaults are being bound, so a default of (Split-Path -Parent $PSScriptRoot) fails before
# the script runs at all.
if (-not $Path) {
    $Path = Split-Path -Parent $PSScriptRoot
}

# Public documentation, standards, placeholder, and package-feed authorities. Adding an entry here
# is a deliberate act and should be obvious in review.
$allowedAuthorities = @(
    'example.com',
    'example.org',
    'example.net',
    'tfs.example.com',
    'localhost',
    '127.0.0.1',
    'schemas.microsoft.com',
    'schemas.xmlsoap.org',
    'microsoft.com',
    'learn.microsoft.com',
    'docs.microsoft.com',
    'marketplace.visualstudio.com',
    'dev.azure.com',
    'www.w3.org',
    'github.com',
    'www.github.com',
    'raw.githubusercontent.com',
    'registry.npmjs.org',
    'www.npmjs.com',
    'api.nuget.org',
    'nuget.org',
    'www.nuget.org',
    'opensource.org',
    'nodejs.org'
)

# Domain part of placeholder account names used in fixtures and documentation.
$allowedAccountDomains = @('EXAMPLE', 'DOMAIN', 'CONTOSO')

# Binary or vendored content that is either unreadable as text or not ours to police.
$skippedExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.ico', '.vsix', '.zip', '.dll', '.exe')

# Machine-generated dependency manifests. These carry funding and homepage URLs for every transitive
# package, which are third-party content rather than references to anyone's environment.
$skippedFileNames = @('package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock')

Push-Location $Path
try {
    $trackedFiles = & git ls-files
    if ($LASTEXITCODE -ne 0) {
        throw "Could not list tracked files. Is '$Path' a git repository?"
    }
}
finally {
    Pop-Location
}

$findings = [System.Collections.Generic.List[string]]::new()

foreach ($relativePath in $trackedFiles) {
    if ([string]::IsNullOrWhiteSpace($relativePath)) {
        continue
    }

    $extension = [System.IO.Path]::GetExtension($relativePath)
    if ($skippedExtensions -contains $extension.ToLowerInvariant()) {
        continue
    }

    $fileName = [System.IO.Path]::GetFileName($relativePath)
    if ($skippedFileNames -contains $fileName.ToLowerInvariant()) {
        continue
    }

    $fullPath = Join-Path $Path $relativePath
    if (-not (Test-Path -LiteralPath $fullPath)) {
        continue
    }

    $lineNumber = 0
    foreach ($line in (Get-Content -LiteralPath $fullPath)) {
        $lineNumber++

        foreach ($match in [regex]::Matches($line, '(?i)\bhttps?://([^/\s"''<>)\]\\]+)')) {
            $authority = $match.Groups[1].Value.Split('@')[-1].Split(':')[0]
            if ($allowedAuthorities -notcontains $authority.ToLowerInvariant()) {
                $findings.Add("${relativePath}:${lineNumber}: non-allowlisted host '$authority'")
            }
        }

        foreach ($match in [regex]::Matches($line, '(?<!\w)\\\\\\\\?[A-Za-z0-9][A-Za-z0-9._-]{2,}\\')) {
            $findings.Add("${relativePath}:${lineNumber}: looks like a UNC path '$($match.Value)'")
        }

        foreach ($match in [regex]::Matches($line, '(?<![\w\\])([A-Z][A-Z0-9-]{2,14})\\\\?([a-z][a-z0-9._-]{2,})')) {
            $accountDomain = $match.Groups[1].Value
            if ($allowedAccountDomains -notcontains $accountDomain) {
                $findings.Add("${relativePath}:${lineNumber}: looks like an account name '$($match.Value)'")
            }
        }
    }
}

if ($findings.Count -gt 0) {
    Write-Host "Found $($findings.Count) possible environment reference(s):" -ForegroundColor Red
    foreach ($finding in $findings) {
        Write-Host "  $finding" -ForegroundColor Red
    }
    Write-Host ''
    Write-Host 'Pass the value as a parameter instead of hard-coding it. If the reference is genuinely'
    Write-Host 'public, add its authority to the allowlist in this script.'
    exit 1
}

Write-Host "No environment references found in $($trackedFiles.Count) tracked file(s)." -ForegroundColor Green
