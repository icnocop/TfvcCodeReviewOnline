<#
.SYNOPSIS
    Adds allow-same-origin to the sandbox attribute Azure DevOps Server applies to extension frames,
    so extensions can authenticate as the signed-in user without a personal access token.

.DESCRIPTION
    Azure DevOps renders extension content in a sandboxed iframe without `allow-same-origin`. That
    gives the frame an opaque origin, so every request it makes is cross-origin even against its own
    server, cookies cannot be sent, and Windows authentication never applies. This is why the
    Comments tab otherwise has to ask each user for a personal access token.

    The sandbox attribute is set in one shipped file, in both a minified and a debug flavor:

        <install>\Application Tier\Web Services\_static\tfs\<version>\_scripts\TFS\<flavor>\VSS\Contributions\Controls.js

    This script edits that file in place, after backing it up. The web bundle is generated from these
    files, so there is nothing to copy into inetpub and no URL rewrite rule to maintain.

    Run it on the Azure DevOps Server application tier, from an elevated prompt. Start with -WhatIf.

    Read before running:

      * This modifies a file Microsoft ships, and is not supported. A server update replaces the
        file, so the change must be reapplied afterwards. That is safer than the URL-rewrite approach
        sometimes suggested for this, where a stale rule survives an upgrade and serves outdated
        script against a newer server.
      * It relaxes isolation for EVERY extension installed on this server, not just one. That sandbox
        attribute is what stops an installed extension from acting against the signed-in user's
        session. Weigh that against the convenience of not distributing personal access tokens.

.PARAMETER InstallPath
    Root of the Azure DevOps Server installation. Located automatically when omitted.

.PARAMETER Revert
    Remove allow-same-origin, restoring the shipped behavior.

.EXAMPLE
    .\Set-ExtensionFrameSameOrigin.ps1 -WhatIf

.EXAMPLE
    .\Set-ExtensionFrameSameOrigin.ps1

.EXAMPLE
    .\Set-ExtensionFrameSameOrigin.ps1 -Revert
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param (
    [Parameter()]
    [string] $InstallPath,

    [Parameter()]
    [switch] $Revert
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Matches the sandbox attribute assignment and captures its value, in group 3.
#
# Both flavors have to be handled: the minified file writes .attr("sandbox","allow-forms ...") with
# double quotes and no spaces, while the debug file writes .attr('sandbox', 'allow-forms ...') with
# single quotes and a space after the comma. Anchoring on allow-top-navigation keeps the edit on the
# right assignment, and capturing the value means the flag can be added or removed without touching
# any other byte of a minified file.
$sandboxPattern = "sandbox(['`"])\s*,\s*(['`"])([^'`"]*allow-top-navigation[^'`"]*)\2"
$flag = 'allow-same-origin'

# Module whose file carries the sandbox attribute, as named in the bundle metadata.
$moduleName = 'VSS/Contributions/Controls'

# Matches that module's recorded hash in a bundle metadata document, capturing the hash in group 2.
#
# Editing Controls.js is not enough on its own. Azure DevOps registers each bundle under a name
# derived from the hashes of the modules it contains, and serves the module content it has cached
# against those hashes. The hash is not a hash of the file (verified: they differ), so a file edit
# changes nothing the server considers stale, and the old content survives even an IIS restart.
# Changing the recorded hash makes the bundle name change, which forces the content to be rebuilt
# from the file on disk.
$moduleHashPattern = '("' + [regex]::Escape($moduleName) + '"\s*:\s*\{[^}]*?"hash"\s*:\s*")([^"]+)(")'

function Resolve-InstallPath {
    param ([string] $ExplicitPath)

    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "No Azure DevOps Server installation at '$ExplicitPath'."
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    $candidates = Get-ChildItem -Path 'C:\Program Files\Azure DevOps Server *' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate.FullName 'Application Tier\Web Services')) {
            return $candidate.FullName
        }
    }

    throw 'Could not find an Azure DevOps Server installation. Pass -InstallPath.'
}

$resolvedInstallPath = Resolve-InstallPath -ExplicitPath $InstallPath
Write-Verbose "Using $resolvedInstallPath"

$staticRoot = Join-Path $resolvedInstallPath 'Application Tier\Web Services\_static\tfs'
if (-not (Test-Path -LiteralPath $staticRoot)) {
    throw "Expected static content at '$staticRoot' but it is not there. Is this an application tier?"
}

# Normally one version directory, but an upgraded server can retain more than one. Every copy that
# carries the attribute is updated, so the result does not depend on which one is being served.
$targets = [System.Collections.Generic.List[object]]::new()
foreach ($versionDirectory in (Get-ChildItem -LiteralPath $staticRoot -Directory)) {
    foreach ($flavor in @('min', 'debug')) {
        $candidate = Join-Path $versionDirectory.FullName "_scripts\TFS\$flavor\VSS\Contributions\Controls.js"
        if (Test-Path -LiteralPath $candidate) {
            $targets.Add([pscustomobject] @{
                Path    = $candidate
                Version = $versionDirectory.Name
                Flavor  = $flavor
            })
        }
    }
}

if ($targets.Count -eq 0) {
    throw "Found no VSS\Contributions\Controls.js under '$staticRoot'."
}

$changed = 0
$alreadyCorrect = 0
# Counted separately from $changed: under -WhatIf nothing is written, and reporting "nothing to do"
# when two files would in fact be edited is worse than saying nothing at all.
$wouldChange = 0

foreach ($target in $targets) {
    $label = "$($target.Version) $($target.Flavor)"
    $content = [System.IO.File]::ReadAllText($target.Path)

    $match = [regex]::Match($content, $sandboxPattern)
    if (-not $match.Success) {
        Write-Warning "$label : no sandbox attribute found; skipping. The file may have changed in this version."
        continue
    }

    $valueGroup = $match.Groups[3]
    $currentValue = $valueGroup.Value
    $isPatched = $currentValue -match "\b$flag\b"

    if ($Revert) {
        if (-not $isPatched) {
            Write-Host "$label : already unpatched."
            $alreadyCorrect++
            continue
        }
        $newValue = ($currentValue -replace "\s*\b$flag\b", '').Trim()
        $action = "remove $flag from"
    }
    else {
        if ($isPatched) {
            Write-Host "$label : already patched."
            $alreadyCorrect++
            continue
        }
        $newValue = "$currentValue $flag"
        $action = "add $flag to"
    }

    # Replace only the captured attribute value, by position, so nothing else in the file moves.
    $updated = $content.Remove($valueGroup.Index, $valueGroup.Length).Insert($valueGroup.Index, $newValue)

    if ($updated -eq $content) {
        Write-Warning "$label : the edit produced no change; skipping."
        continue
    }

    $wouldChange++

    if (-not $PSCmdlet.ShouldProcess($target.Path, $action)) {
        continue
    }

    # Backed up beside the original so the shipped file is always recoverable.
    $backupPath = "$($target.Path).$(Get-Date -Format 'yyyyMMdd-HHmmss').backup"
    Copy-Item -LiteralPath $target.Path -Destination $backupPath
    [System.IO.File]::WriteAllText($target.Path, $updated)

    Write-Host "$label : patched. Backup: $backupPath"
    $changed++
}

# --- bundle metadata -----------------------------------------------------------------------------
# Backing the file edit with a hash change, so the server rebuilds the bundle instead of serving the
# copy it cached against the old hash.
function Get-Base64Sha256([string] $text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [Convert]::ToBase64String($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text)))
    }
    finally {
        $sha.Dispose()
    }
}

foreach ($versionDirectory in (Get-ChildItem -LiteralPath $staticRoot -Directory)) {
    $metadataDirectory = Join-Path $versionDirectory.FullName 'Bundle_Metadata'
    if (-not (Test-Path -LiteralPath $metadataDirectory)) {
        continue
    }

    foreach ($metadataFile in (Get-ChildItem -LiteralPath $metadataDirectory -Filter '*.json' -File)) {
        $metadataContent = [System.IO.File]::ReadAllText($metadataFile.FullName)
        $metadataMatch = [regex]::Match($metadataContent, $moduleHashPattern)
        if (-not $metadataMatch.Success) {
            continue
        }

        $hashGroup = $metadataMatch.Groups[2]
        $label = "$($versionDirectory.Name) $($metadataFile.Name)"

        if ($Revert) {
            # The original hash is not recoverable by computation, so it is read back out of the
            # backup this script took when patching.
            $metadataBackup = Get-ChildItem -LiteralPath $metadataDirectory -Filter "$($metadataFile.Name).*.backup" -File -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                Select-Object -First 1
            if (-not $metadataBackup) {
                Write-Warning "$label : no backup found, so the original hash cannot be restored. Leaving it as is."
                continue
            }
            $originalMatch = [regex]::Match([System.IO.File]::ReadAllText($metadataBackup.FullName), $moduleHashPattern)
            if (-not $originalMatch.Success) {
                Write-Warning "$label : the backup does not contain the module hash. Leaving it as is."
                continue
            }
            $newHash = $originalMatch.Groups[2].Value
            $metadataAction = 'restore the original module hash in'
        }
        else {
            # Any stable value that differs from the recorded one will do; the hash of the patched
            # file is deterministic, so re-running produces no further change.
            $patchedFile = Join-Path $versionDirectory.FullName "_scripts\TFS\min\VSS\Contributions\Controls.js"
            if (-not (Test-Path -LiteralPath $patchedFile)) {
                continue
            }
            $newHash = Get-Base64Sha256 ([System.IO.File]::ReadAllText($patchedFile))
            $metadataAction = 'change the module hash in'
        }

        if ($hashGroup.Value -eq $newHash) {
            Write-Host "$label : module hash already correct."
            $alreadyCorrect++
            continue
        }

        $wouldChange++
        if (-not $PSCmdlet.ShouldProcess($metadataFile.FullName, $metadataAction)) {
            continue
        }

        if (-not $Revert) {
            $metadataBackupPath = "$($metadataFile.FullName).$(Get-Date -Format 'yyyyMMdd-HHmmss').backup"
            Copy-Item -LiteralPath $metadataFile.FullName -Destination $metadataBackupPath
            Write-Host "$label : backed up to $(Split-Path $metadataBackupPath -Leaf)"
        }

        $updatedMetadata = $metadataContent.Remove($hashGroup.Index, $hashGroup.Length).Insert($hashGroup.Index, $newHash)
        [System.IO.File]::WriteAllText($metadataFile.FullName, $updatedMetadata)
        Write-Host "$label : module hash updated."
        $changed++
    }
}

Write-Host ''
if ($changed -eq 0) {
    if ($wouldChange -gt 0) {
        $verb = if ($Revert) { 'reverted' } else { 'patched' }
        Write-Host "$wouldChange file(s) would be $verb. Re-run without -WhatIf to apply."
    }
    else {
        Write-Host "Nothing to do ($alreadyCorrect file(s) already in the requested state)."
    }
    return
}

# Deliberately not restarting IIS here. This runs on a shared server, and taking the site down is the
# operator's call, not the script's.
Write-Host 'The web bundle is cached, so restart IIS or recycle the application pool for the change'
Write-Host 'to take effect:'
Write-Host ''
Write-Host '    iisreset'
Write-Host ''
Write-Host 'Then hard-refresh a work item, because the old bundle is cached in the browser too.'
Write-Host 'To confirm, inspect the extension iframe in developer tools and check that its sandbox'
Write-Host "attribute $(if ($Revert) { 'no longer includes' } else { 'includes' }) allow-same-origin."
