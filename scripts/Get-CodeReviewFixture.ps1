<#
.SYNOPSIS
    Captures a discussion threads response from a live server and anonymizes it into a test fixture.

.DESCRIPTION
    The unit tests need payloads that are structurally faithful to what the server really sends --
    the $type/$value property envelopes, the absent parentId on root comments, real CRLF pairs in
    comment text -- without containing anything identifying, because this repository is public.

    This script keeps all of that structure and replaces every free-text and identity value with a
    deterministic placeholder:

      * identities      -> Sample User N / sample.userN@example.com, with placeholder GUIDs
      * item paths      -> $/<Project>/src/SampleN.<original extension>
      * artifact URIs   -> a placeholder shelveset name and owner, escaping preserved
      * comment content -> placeholder text with the original line count preserved

    Before writing, it asserts that none of the original values survive anywhere in the document. If
    that check fails it writes nothing, so a leak takes deliberate effort rather than a slip.

.PARAMETER CollectionUri
    Root URI of the team project collection, for example https://tfs.example.com/DefaultCollection.

.PARAMETER WorkItemId
    ID of a Code Review Request work item.

.PARAMETER OutFile
    Where to write the anonymized fixture.

.PARAMETER PlaceholderDomain
    Domain written into the fixture in place of the real account domain.

.PARAMETER PlaceholderProject
    Team project name written into the fixture in place of the real one.

.PARAMETER Credential
    Explicit credentials. When omitted the current Windows identity is used.

.EXAMPLE
    .\Get-CodeReviewFixture.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -WorkItemId 1234 `
        -OutFile ..\tests\TfvcCodeReviewOnline.Tests\fixtures\discussionThreads.response.json
#>
[CmdletBinding()]
param (
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $CollectionUri,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int] $WorkItemId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $OutFile,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $PlaceholderDomain = 'EXAMPLE',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $PlaceholderProject = 'ExampleProject',

    [Parameter()]
    [System.Management.Automation.PSCredential] $Credential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$collectionRoot = $CollectionUri.TrimEnd('/')
$requestUri = "$collectionRoot/_apis/discussion/threads?workItemId=$WorkItemId&api-version=3.0-preview.1"

$requestArguments = @{ Uri = $requestUri; ErrorAction = 'Stop' }
if ($Credential) { $requestArguments['Credential'] = $Credential }
else { $requestArguments['UseDefaultCredentials'] = $true }

if (([uri] $collectionRoot).Scheme -ne 'https' -and $PSVersionTable.PSEdition -eq 'Core') {
    Write-Warning "$collectionRoot is not HTTPS; credentials will be sent over an unencrypted connection."
    $requestArguments['AllowUnencryptedAuthentication'] = $true
}

Write-Verbose "Requesting $requestUri"
$progressPreferenceBackup = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
try {
    $response = Invoke-RestMethod @requestArguments
}
finally {
    $ProgressPreference = $progressPreferenceBackup
}

# Every replaced value is recorded so the final check can prove each original is gone.
$originalValues = [System.Collections.Generic.List[string]]::new()
function Add-OriginalValue([string] $value) {
    if (-not [string]::IsNullOrWhiteSpace($value)) { $originalValues.Add($value) }
}

$identityMap = @{}
$identityIndex = 0
function Resolve-Identity([string] $id) {
    $key = $id.ToLowerInvariant()
    if (-not $identityMap.ContainsKey($key)) {
        $script:identityIndex++
        $identityMap[$key] = [pscustomobject] @{
            Index = $script:identityIndex
            Guid  = ('00000000-0000-4000-8000-{0:d12}' -f $script:identityIndex)
        }
    }
    return $identityMap[$key]
}

$pathMap = @{}
$pathIndex = 0
$commentIndex = 0

foreach ($thread in $response.value) {
    if ($thread.PSObject.Properties['artifactUri'] -and $thread.artifactUri) {
        Add-OriginalValue $thread.artifactUri
        $placeholder = $thread.artifactUri
        # Shelveset artifact URIs are double-escaped; the shape is preserved and only names swapped.
        $placeholder = [regex]::Replace($placeholder, '(?<=/Shelveset/)[^%]+', 'SampleShelveset1')
        $placeholder = [regex]::Replace(
            $placeholder, '(?<=shelvesetOwner%253d).+$', "$PlaceholderDomain%25255csample.user1")
        $thread.artifactUri = $placeholder
    }

    if ($thread.PSObject.Properties['properties'] -and $thread.properties) {
        $itemPathProperty = $thread.properties.PSObject.Properties['Microsoft.TeamFoundation.Discussion.ItemPath']
        if ($itemPathProperty) {
            $originalPath = $itemPathProperty.Value.'$value'
            if (-not $pathMap.ContainsKey($originalPath)) {
                $pathIndex++
                $extension = [System.IO.Path]::GetExtension($originalPath)
                $pathMap[$originalPath] = "`$/$PlaceholderProject/src/Sample$pathIndex$extension"
            }
            Add-OriginalValue $originalPath
            $itemPathProperty.Value.'$value' = $pathMap[$originalPath]
        }
    }

    foreach ($comment in $thread.comments) {
        $commentIndex++

        if ($comment.PSObject.Properties['author'] -and $comment.author) {
            $identity = Resolve-Identity ([string] $comment.author.id)
            foreach ($field in @('id', 'displayName', 'uniqueName', 'imageUrl', 'descriptor', 'url')) {
                $property = $comment.author.PSObject.Properties[$field]
                if (-not $property -or -not $property.Value) { continue }
                Add-OriginalValue ([string] $property.Value)
                $property.Value = switch ($field) {
                    'id'          { $identity.Guid }
                    'displayName' { "Sample User $($identity.Index)" }
                    'uniqueName'  { "sample.user$($identity.Index)@example.com" }
                    default       { "https://tfs.example.com/DefaultCollection/_apis/GraphProfile/MemberAvatars/sample$($identity.Index)" }
                }
            }
            # _links carries a second copy of the avatar URL.
            if ($comment.author.PSObject.Properties['_links']) {
                $comment.author.PSObject.Properties.Remove('_links')
            }
        }

        if ($comment.PSObject.Properties['content'] -and $comment.content) {
            $originalContent = [string] $comment.content
            Add-OriginalValue $originalContent
            # Preserve the line count: multi-line comments are what make rendering interesting.
            $lineCount = ([regex]::Matches($originalContent, "`r`n|`n|`r")).Count + 1
            $lines = 1..$lineCount | ForEach-Object {
                if ($_ -eq 1) { "Sample comment $commentIndex." } else { "Sample continuation line $_." }
            }
            $comment.content = ($lines -join "`r`n")
        }
    }
}

$serialized = $response | ConvertTo-Json -Depth 32
$originatingHost = ([uri] $collectionRoot).Host
$serialized = $serialized.Replace($collectionRoot, 'https://tfs.example.com/DefaultCollection')
$serialized = $serialized.Replace($originatingHost, 'tfs.example.com')

# Placeholder vocabulary. An original value that is a substring of one of these cannot be
# distinguished from the replacement text, so asserting on it would fail every run.
$placeholderVocabulary = @(
    'Sample User', 'sample.user', 'SampleShelveset', 'Sample comment', 'Sample continuation line',
    '00000000-0000-4000-8000-', 'tfs.example.com', 'MemberAvatars',
    $PlaceholderDomain, $PlaceholderProject
)

$leaks = [System.Collections.Generic.List[string]]::new()
foreach ($value in ($originalValues | Sort-Object -Unique)) {
    if ($value.Length -lt 4) { continue }

    $isPlaceholderWord = $false
    foreach ($placeholder in $placeholderVocabulary) {
        if ($placeholder.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $isPlaceholderWord = $true
            break
        }
    }
    if ($isPlaceholderWord) { continue }

    if ($serialized.Contains($value)) { $leaks.Add($value) }
}

if ($leaks.Count -gt 0) {
    $preview = ($leaks | Select-Object -First 5) -join '; '
    throw "Refusing to write the fixture: $($leaks.Count) original value(s) survived anonymization (for example: $preview). Extend the sanitizer."
}

$outputDirectory = Split-Path -Parent $OutFile
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

Set-Content -LiteralPath $OutFile -Value $serialized -Encoding utf8
Write-Host "Wrote anonymized fixture to $OutFile ($identityIndex identity/identities, $pathIndex path(s), $commentIndex comment(s))."
