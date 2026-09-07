<#
.SYNOPSIS
    Adds (or removes) this extension's tab on a work item type form, for on-premises XML process
    model collections.

.DESCRIPTION
    On-premises Azure DevOps Server collections use the XML process model, where a work item form
    extension appears only if the work item type definition asks for it. Installing the extension on
    the collection is not enough: without this change the extension is installed and working, and no
    tab is visible anywhere.

    This script automates the whole round trip:

      1. Exports the work item type definition with witadmin.
      2. Saves an untouched, timestamped backup so the change can be reverted.
      3. Adds <Extensions><Extension Id="..." /></Extensions> and a matching <PageContribution>
         inside <WebLayout>, or removes them when -Remove is specified.
      4. Validates the result with `witadmin importwitd /v`, which checks the definition against the
         schema without writing anything.
      5. Imports it, after confirmation.

    It is idempotent: running it twice makes no second change, and it exits without importing if the
    definition already says what it should.

.PARAMETER CollectionUri
    Root URI of the team project collection, for example https://tfs.example.com/DefaultCollection.

.PARAMETER Project
    Team project whose work item type is being changed. Work item type definitions are per-project,
    so run this once per project whose reviews should show the tab.

.PARAMETER WorkItemTypeName
    Work item type to modify. Defaults to the type that hosts TFVC code reviews.

.PARAMETER ExtensionId
    Publisher-qualified extension ID, as installed on the collection.

.PARAMETER ContributionId
    ID of the work item form page contribution declared in vss-extension.json. Combined with
    ExtensionId to form the full contribution ID.

.PARAMETER PageLabel
    Text shown on the tab.

.PARAMETER WitAdminPath
    Full path to witadmin.exe. Located automatically from the Visual Studio installs when omitted.

.PARAMETER BackupDirectory
    Where to write the pre-change backup. Defaults to the current directory.

.PARAMETER Remove
    Remove the extension and page contribution instead of adding them.

.EXAMPLE
    .\Set-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject"

.EXAMPLE
    .\Set-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject" -WhatIf

    Shows what would change, including schema validation, without importing.

.EXAMPLE
    .\Set-WorkItemFormExtension.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -Project "ExampleProject" -Remove

    Reverts the form to its original layout.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
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
    [ValidateNotNullOrEmpty()]
    [string] $PageLabel = 'Comments',

    [Parameter()]
    [string] $WitAdminPath,

    [Parameter()]
    [string] $BackupDirectory = (Get-Location).Path,

    [Parameter()]
    [switch] $Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$fullContributionId = "$ExtensionId.$ContributionId"

function Resolve-WitAdmin {
    param ([string] $ExplicitPath)

    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "witadmin.exe was not found at '$ExplicitPath'."
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    # witadmin ships with the Team Explorer component of Visual Studio and is not on PATH.
    $candidates = @(
        'C:\Program Files\Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\witadmin.exe',
        'C:\Program Files (x86)\Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\witadmin.exe'
    )

    foreach ($candidate in $candidates) {
        $found = Get-ChildItem -Path $candidate -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) {
            return $found.FullName
        }
    }

    throw 'Could not find witadmin.exe. Install the Visual Studio "Team Explorer" component, or pass -WitAdminPath.'
}

<#
    Runs witadmin and fails on error.

    The exit code alone is not enough: witadmin returns 0 even when a definition fails schema
    validation or an import is rejected, reporting the problem only in its output. Checking the exit
    code by itself makes a failed validation look like a successful one.
#>
function Invoke-WitAdmin {
    param (
        [string] $WitAdmin,
        [string[]] $Arguments,
        [string] $FailureMessage
    )

    # witadmin reports failures with both TF and VS error codes: a schema violation comes back as
    # TF237070, while referencing an extension that is not installed comes back as VS403121.
    $errorPattern = '(?:TF|VS)\d{5,6}|did not validate|invalid child element|has invalid child|is not valid|is invalid|does not exist'

    Write-Verbose "witadmin $($Arguments -join ' ')"
    $output = & $WitAdmin @Arguments 2>&1
    $text = ($output | Out-String).Trim()

    if ($LASTEXITCODE -ne 0 -or $text -match $errorPattern) {
        throw "$FailureMessage`n$text"
    }
    return $output
}

<#
    Returns the whitespace used to indent the children of a node, taken from the document itself so
    the edit matches the surrounding formatting rather than imposing its own.
#>
function Get-ChildIndent {
    param ([System.Xml.XmlNode] $Parent, [string] $Fallback)

    foreach ($child in $Parent.ChildNodes) {
        if ($child.NodeType -eq [System.Xml.XmlNodeType]::Whitespace -or
            $child.NodeType -eq [System.Xml.XmlNodeType]::SignificantWhitespace) {
            $text = $child.Value -replace "^[\r\n]+", ''
            if ($text) {
                return $text
            }
        }
    }
    return $Fallback
}

function Add-IndentedChild {
    param (
        [System.Xml.XmlNode] $Parent,
        [System.Xml.XmlNode] $NewChild,
        [System.Xml.XmlNode] $After,
        [System.Xml.XmlNode] $Before,
        [string] $Indent
    )

    $document = $Parent.OwnerDocument

    if ($Before) {
        [void] $Parent.InsertBefore($NewChild, $Before)
        [void] $Parent.InsertAfter($document.CreateWhitespace([Environment]::NewLine + $Indent), $NewChild)
        return
    }

    $separator = $document.CreateWhitespace([Environment]::NewLine + $Indent)

    if ($After) {
        $anchor = $Parent.InsertAfter($separator, $After)
        [void] $Parent.InsertAfter($NewChild, $anchor)
    }
    else {
        [void] $Parent.AppendChild($separator)
        [void] $Parent.AppendChild($NewChild)
    }
}

function Remove-NodeWithLeadingWhitespace {
    param ([System.Xml.XmlNode] $Node)

    $previous = $Node.PreviousSibling
    $parent = $Node.ParentNode
    [void] $parent.RemoveChild($Node)
    if ($previous -and
        ($previous.NodeType -eq [System.Xml.XmlNodeType]::Whitespace -or
         $previous.NodeType -eq [System.Xml.XmlNodeType]::SignificantWhitespace)) {
        [void] $parent.RemoveChild($previous)
    }
}

$witAdmin = Resolve-WitAdmin -ExplicitPath $WitAdminPath
Write-Verbose "Using $witAdmin"

$workingFile = Join-Path ([System.IO.Path]::GetTempPath()) ("witd-" + [guid]::NewGuid().ToString('n') + '.xml')

try {
    Write-Host "Exporting '$WorkItemTypeName' from $Project..."
    [void] (Invoke-WitAdmin -WitAdmin $witAdmin -Arguments @(
        'exportwitd',
        "/collection:$CollectionUri",
        "/p:$Project",
        "/n:$WorkItemTypeName",
        "/f:$workingFile"
    ) -FailureMessage "Failed to export the '$WorkItemTypeName' work item type definition.")

    # Written even under -WhatIf: taking a backup changes nothing on the server, and a dry run that
    # reports a backup it did not take would be lying.
    if (-not (Test-Path -LiteralPath $BackupDirectory)) {
        New-Item -ItemType Directory -Force -Path $BackupDirectory -WhatIf:$false | Out-Null
    }
    $safeTypeName = ($WorkItemTypeName -replace '[^A-Za-z0-9]', '')
    $backupFile = Join-Path $BackupDirectory ("$safeTypeName-$(Get-Date -Format 'yyyyMMdd-HHmmss').backup.xml")
    Copy-Item -LiteralPath $workingFile -Destination $backupFile -WhatIf:$false
    Write-Host "Backed up the current definition to $backupFile"

    $document = New-Object System.Xml.XmlDocument
    # Keeps the untouched parts of the file byte-identical, so the change is easy to review.
    $document.PreserveWhitespace = $true
    $document.Load($workingFile)

    # Only the root element is namespace-qualified; FORM and everything under it are not.
    $webLayout = $document.SelectSingleNode('/*/WORKITEMTYPE/FORM/WebLayout')
    if (-not $webLayout) {
        throw "'$WorkItemTypeName' has no <WebLayout> section, so it still uses the old work item form. Enable the new form for this collection before adding a form extension."
    }

    $childIndent = Get-ChildIndent -Parent $webLayout -Fallback '        '
    $grandChildIndent = $childIndent + '  '

    $extensionsElement = $webLayout.SelectSingleNode('Extensions')
    $extensionElement = $webLayout.SelectSingleNode("Extensions/Extension[@Id='$ExtensionId']")
    $pageContribution = $webLayout.SelectSingleNode("PageContribution[@Id='$fullContributionId']")

    $changes = New-Object System.Collections.Generic.List[string]

    if ($Remove) {
        if ($extensionElement) {
            Remove-NodeWithLeadingWhitespace -Node $extensionElement
            $changes.Add("removed <Extension Id=""$ExtensionId"" />")

            # Drop the container too if this was the only extension it held.
            if ($extensionsElement -and -not $extensionsElement.SelectSingleNode('Extension')) {
                Remove-NodeWithLeadingWhitespace -Node $extensionsElement
                $changes.Add('removed the now-empty <Extensions> element')
            }
        }

        if ($pageContribution) {
            Remove-NodeWithLeadingWhitespace -Node $pageContribution
            $changes.Add("removed <PageContribution Id=""$fullContributionId"" />")
        }
    }
    else {
        if (-not $extensionsElement) {
            $extensionsElement = $document.CreateElement('Extensions')

            # <Extensions> has to be the first child of <WebLayout>, ahead of <SystemControls>.
            # The documentation only says to place it "prior to a Page element", but the schema is
            # stricter than that: with <Extensions> after <SystemControls>, witadmin rejects the
            # definition with "The element 'WebLayout' has invalid child element 'Extensions'. List
            # of possible elements expected: 'Page, PageContribution'."
            $systemControls = $webLayout.SelectSingleNode('SystemControls')
            if ($systemControls) {
                Add-IndentedChild -Parent $webLayout -NewChild $extensionsElement -Before $systemControls -Indent $childIndent
            }
            else {
                $firstChild = $webLayout.SelectSingleNode('*')
                if ($firstChild) {
                    Add-IndentedChild -Parent $webLayout -NewChild $extensionsElement -Before $firstChild -Indent $childIndent
                }
                else {
                    Add-IndentedChild -Parent $webLayout -NewChild $extensionsElement -After $null -Indent $childIndent
                }
            }
            $changes.Add('added an <Extensions> element')
        }

        if (-not $extensionElement) {
            $extensionElement = $document.CreateElement('Extension')
            $extensionElement.SetAttribute('Id', $ExtensionId)
            Add-IndentedChild -Parent $extensionsElement -NewChild $extensionElement -After $null -Indent $grandChildIndent

            # Close the container onto its own line when it was created empty a moment ago.
            if (-not $extensionsElement.InnerXml.EndsWith($childIndent)) {
                [void] $extensionsElement.AppendChild($document.CreateWhitespace([Environment]::NewLine + $childIndent))
            }
            $changes.Add("added <Extension Id=""$ExtensionId"" />")
        }

        if (-not $pageContribution) {
            $pageContribution = $document.CreateElement('PageContribution')
            $pageContribution.SetAttribute('Id', $fullContributionId)
            $pageContribution.SetAttribute('Label', $PageLabel)

            # Appended last so the tab appears after the built-in pages.
            $lastPage = $webLayout.SelectNodes('Page') | Select-Object -Last 1
            Add-IndentedChild -Parent $webLayout -NewChild $pageContribution -After $lastPage -Indent $childIndent
            $changes.Add("added <PageContribution Id=""$fullContributionId"" Label=""$PageLabel"" />")
        }
    }

    if ($changes.Count -eq 0) {
        $state = if ($Remove) { 'does not reference' } else { 'already references' }
        Write-Host "No change needed: '$WorkItemTypeName' in $Project $state $fullContributionId."
        return
    }

    $writerSettings = New-Object System.Xml.XmlWriterSettings
    # The document's own whitespace is preserved, so the writer must not add any of its own.
    $writerSettings.Indent = $false
    $writerSettings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $writer = [System.Xml.XmlWriter]::Create($workingFile, $writerSettings)
    try {
        $document.Save($writer)
    }
    finally {
        $writer.Dispose()
    }

    Write-Host 'Changes to apply:'
    foreach ($change in $changes) {
        Write-Host "  - $change"
    }

    # Schema-validates against the collection without writing, so a malformed edit is caught before
    # anything is committed.
    Write-Host 'Validating the modified definition...'
    [void] (Invoke-WitAdmin -WitAdmin $witAdmin -Arguments @(
        'importwitd',
        "/collection:$CollectionUri",
        "/p:$Project",
        "/f:$workingFile",
        '/v'
    ) -FailureMessage 'The modified work item type definition failed validation. Nothing was imported.')
    Write-Host 'Validation passed.'

    $target = "'$WorkItemTypeName' in project '$Project' on $CollectionUri"
    $action = if ($Remove) { "remove the '$PageLabel' tab from" } else { "add the '$PageLabel' tab to" }
    if (-not $PSCmdlet.ShouldProcess($target, $action)) {
        Write-Host "Skipped the import. The modified definition is at $workingFile"
        $script:keepWorkingFile = $true
        return
    }

    Write-Host 'Importing...'
    [void] (Invoke-WitAdmin -WitAdmin $witAdmin -Arguments @(
        'importwitd',
        "/collection:$CollectionUri",
        "/p:$Project",
        "/f:$workingFile"
    ) -FailureMessage "Failed to import the modified '$WorkItemTypeName' work item type definition.")

    Write-Host ''
    if ($Remove) {
        Write-Host "Done. The '$PageLabel' tab has been removed from '$WorkItemTypeName' in $Project."
    }
    else {
        Write-Host "Done. Reload a '$WorkItemTypeName' work item and the '$PageLabel' tab will be there."
        Write-Host 'A hard refresh may be needed, because the form layout is cached in the browser.'
    }
    Write-Host "To revert, re-run with -Remove, or import the backup: $backupFile"
}
finally {
    if ((Test-Path -LiteralPath $workingFile) -and -not (Get-Variable -Name keepWorkingFile -Scope Script -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $workingFile -Force -ErrorAction SilentlyContinue -WhatIf:$false
    }
}
