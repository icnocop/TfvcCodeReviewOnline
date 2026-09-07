<#
.SYNOPSIS
    Removes this extension's tab from a work item type form, for on-premises XML process model
    collections.

.DESCRIPTION
    Exports the work item type definition with witadmin, strips the <Extension> and
    <PageContribution> entries this extension added, validates the result, and imports it back.

    Run this *before* uninstalling the extension from the collection, or as soon as possible after.
    A work item type definition that references an extension which is no longer installed cannot be
    imported: witadmin rejects it with

        VS403121: Extension(s) "<id>" does not exist, or has no work item form contribution.

    which blocks any later change to that work item type, including changes that have nothing to do
    with this extension. Removing the reference first avoids that.

    This is a thin wrapper over Set-WorkItemFormExtension.ps1 -Remove, which does the actual work;
    the two share one implementation so they cannot drift apart.

.PARAMETER CollectionUri
    Root URI of the team project collection, for example https://tfs.example.com/DefaultCollection.

.PARAMETER Project
    Team project whose work item type is being changed.

.PARAMETER WorkItemTypeName
    Work item type to modify. Defaults to the type that hosts TFVC code reviews.

.PARAMETER ExtensionId
    Publisher-qualified extension ID to remove.

.PARAMETER ContributionId
    ID of the work item form page contribution declared in vss-extension.json.

.PARAMETER WitAdminPath
    Full path to witadmin.exe. Located automatically from the Visual Studio installs when omitted.

.PARAMETER BackupDirectory
    Where to write the pre-change backup. Defaults to the current directory.

.EXAMPLE
    .\Remove-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject" -WhatIf

.EXAMPLE
    .\Remove-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject"
#>
# SupportsShouldProcess so -WhatIf and -Confirm are accepted and forwarded. ConfirmImpact is left at
# the default on purpose: the script being called declares High and does its own confirmation, and
# declaring it here as well would prompt twice for one action.
[CmdletBinding(SupportsShouldProcess = $true)]
param (
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $CollectionUri,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $Project,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $WorkItemTypeName = 'Code Review Request',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $ExtensionId = 'icnocop.tfvc-code-review-online',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $ContributionId = 'code-review-comments',

    [Parameter()]
    [string] $WitAdminPath,

    [Parameter()]
    [string] $BackupDirectory = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$setScript = Join-Path $PSScriptRoot 'Set-WorkItemFormExtension.ps1'
if (-not (Test-Path -LiteralPath $setScript)) {
    throw "Set-WorkItemFormExtension.ps1 was not found next to this script at '$setScript'."
}

$arguments = @{
    CollectionUri    = $CollectionUri
    Project          = $Project
    WorkItemTypeName = $WorkItemTypeName
    ExtensionId      = $ExtensionId
    ContributionId   = $ContributionId
    BackupDirectory  = $BackupDirectory
    Remove           = $true
}

if ($WitAdminPath) {
    $arguments['WitAdminPath'] = $WitAdminPath
}

# Forwards -WhatIf and -Verbose so the wrapper behaves exactly like the script it calls. Confirmation
# is left to that script, which declares ConfirmImpact High and prompts before importing.
& $setScript @arguments `
    -WhatIf:$WhatIfPreference `
    -Verbose:($VerbosePreference -eq [System.Management.Automation.ActionPreference]::Continue)
