<#
.SYNOPSIS
    Exports the comments and replies of a TFVC code review to a self-contained HTML file.

.DESCRIPTION
    Reads a Code Review Request work item's discussion threads from the collection's REST API and
    writes them out as a single HTML file grouped by file, with replies nested under the comment they
    answer.

    Two reasons this exists alongside the extension:

      * It works from any machine with network access to the collection, with nothing installed.
      * It is the contract check. After an Azure DevOps Server upgrade, running this against a known
        review confirms in seconds whether the discussion API still returns what we expect.

.PARAMETER CollectionUri
    Root URI of the team project collection, for example https://tfs.example.com/DefaultCollection.

.PARAMETER WorkItemId
    ID of a Code Review Request work item.

.PARAMETER OutFile
    Where to write the HTML. Defaults to CodeReview-<WorkItemId>.html in the current directory.

.PARAMETER PassThru
    Also emit the parsed threads as objects, for scripting against.

.PARAMETER Credential
    Explicit credentials. When omitted the current Windows identity is used, which is what you want
    against a domain-joined on-premises server.

.EXAMPLE
    .\Export-CodeReviewComments.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -WorkItemId 1234

.EXAMPLE
    .\Export-CodeReviewComments.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -WorkItemId 1234 -PassThru |
        Where-Object { $_.Level -eq 'code' }
#>
[CmdletBinding()]
param (
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $CollectionUri,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int] $WorkItemId,

    [Parameter()]
    [string] $OutFile,

    [Parameter()]
    [switch] $PassThru,

    [Parameter()]
    [System.Management.Automation.PSCredential] $Credential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$apiVersion = '3.0-preview.1'
$itemPathProperty = 'Microsoft.TeamFoundation.Discussion.ItemPath'
$positionPropertyPrefix = 'Microsoft.TeamFoundation.Discussion.Position.'

if (-not $OutFile) {
    $OutFile = Join-Path (Get-Location) "CodeReview-$WorkItemId.html"
}

$collectionRoot = $CollectionUri.TrimEnd('/')
$requestUri = "$collectionRoot/_apis/discussion/threads?workItemId=$WorkItemId&api-version=$apiVersion"

$requestArguments = @{
    Uri         = $requestUri
    ErrorAction = 'Stop'
}

if ($Credential) {
    $requestArguments['Credential'] = $Credential
}
else {
    $requestArguments['UseDefaultCredentials'] = $true
}

# PowerShell 7 refuses to send credentials over plain HTTP unless told to, and on-premises
# collections are commonly HTTP-only on an intranet.
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

# Thread properties arrive wrapped as { "$type": "System.Int32", "$value": 117 } rather than as
# plain values.
function Get-ThreadProperty($thread, [string] $name) {
    if (-not $thread.PSObject.Properties['properties'] -or -not $thread.properties) {
        return $null
    }
    $property = $thread.properties.PSObject.Properties[$name]
    if (-not $property) {
        return $null
    }
    return $property.Value.'$value'
}

$threads = [System.Collections.Generic.List[object]]::new()
foreach ($thread in $response.value) {
    $itemPath = Get-ThreadProperty $thread $itemPathProperty
    $startLine = Get-ThreadProperty $thread "${positionPropertyPrefix}StartLine"
    $endLine = Get-ThreadProperty $thread "${positionPropertyPrefix}EndLine"
    $positionContext = Get-ThreadProperty $thread "${positionPropertyPrefix}PositionContext"

    # There is no level field; it is implied by which anchors are present.
    $level = if (-not $itemPath) { 'review' } elseif ($null -ne $startLine) { 'code' } else { 'file' }

    $comments = [System.Collections.Generic.List[object]]::new()
    foreach ($comment in $thread.comments) {
        $parentId = if ($comment.PSObject.Properties['parentId']) { $comment.parentId } else { $null }
        $author = if ($comment.author.PSObject.Properties['displayName'] -and $comment.author.displayName) {
            $comment.author.displayName
        }
        else {
            $comment.author.id
        }

        $comments.Add([pscustomobject] @{
            Id            = [int] $comment.id
            ParentId      = if ($parentId) { [int] $parentId } else { 0 }
            Author        = $author
            Content       = $comment.content
            PublishedDate = $comment.publishedDate
            IsDeleted     = ($comment.PSObject.Properties['isDeleted'] -and $comment.isDeleted)
        })
    }

    $threads.Add([pscustomobject] @{
        Id              = [int] $thread.id
        Level           = $level
        ItemPath        = $itemPath
        StartLine       = $startLine
        EndLine         = $endLine
        PositionContext = $positionContext
        Status          = if ($thread.PSObject.Properties['status']) { $thread.status } else { $null }
        PublishedDate   = $thread.publishedDate
        LastUpdatedDate = $thread.lastUpdatedDate
        Comments        = $comments
    })
}

function Format-Html([string] $text) {
    if ($null -eq $text) {
        return ''
    }
    return [System.Net.WebUtility]::HtmlEncode($text)
}

function Format-Anchor($thread) {
    if ($null -eq $thread.StartLine) {
        return ''
    }
    $range = if ($thread.EndLine -and $thread.EndLine -ne $thread.StartLine) {
        "lines $($thread.StartLine)-$($thread.EndLine)"
    }
    else {
        "line $($thread.StartLine)"
    }
    if ($thread.PositionContext) {
        return "$range ($($thread.PositionContext))"
    }
    return $range
}

# Replies are expressed with parentId rather than by nesting, so the tree is rebuilt here.
function Write-CommentTree($comments, [int] $parentId, [int] $depth, $builder) {
    foreach ($comment in ($comments | Where-Object { $_.ParentId -eq $parentId } | Sort-Object Id)) {
        $classes = if ($comment.IsDeleted) { 'comment deleted' } else { 'comment' }
        $builder.AppendLine("<div class=""$classes"" style=""margin-left:$($depth * 24)px"">") | Out-Null
        $builder.AppendLine("<div class=""meta""><span class=""author"">$(Format-Html $comment.Author)</span> <span class=""date"">$(Format-Html $comment.PublishedDate)</span>$(if ($comment.IsDeleted) { ' <span class="tag">deleted</span>' })</div>") | Out-Null
        $builder.AppendLine("<div class=""content"">$(Format-Html $comment.Content)</div>") | Out-Null
        $builder.AppendLine('</div>') | Out-Null

        Write-CommentTree $comments ($comment.Id) ($depth + 1) $builder
    }
}

$builder = [System.Text.StringBuilder]::new()
$commentCount = ($threads | ForEach-Object { $_.Comments.Count } | Measure-Object -Sum).Sum

[void] $builder.AppendLine(@"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Code review $WorkItemId</title>
<style>
body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; margin: 24px; color: #1b1b1b; }
h1 { font-size: 20px; margin-bottom: 4px; }
h2 { font-size: 15px; margin: 24px 0 4px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
.summary { color: #555; margin-bottom: 8px; }
.thread { border-left: 3px solid #0078d4; margin: 12px 0; padding: 4px 0 4px 12px; }
.anchor { color: #555; font-size: 12px; margin-bottom: 6px; }
.comment { margin: 6px 0; }
.comment.deleted { opacity: 0.55; }
.meta { font-size: 12px; color: #555; }
.author { font-weight: 600; color: #1b1b1b; }
.tag { background: #eee; border-radius: 3px; padding: 0 4px; }
.content { white-space: pre-wrap; margin-top: 2px; }
.empty { color: #555; font-style: italic; }
code { background: #f3f3f3; padding: 0 3px; }
</style>
</head>
<body>
<h1>Code review $WorkItemId</h1>
<div class="summary">$($threads.Count) thread(s), $commentCount comment(s). Exported $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss').</div>
"@)

if ($threads.Count -eq 0) {
    [void] $builder.AppendLine('<p class="empty">This code review has no published discussion threads.</p>')
}

# Review-level threads first, then one section per file.
$reviewLevel = $threads | Where-Object { $_.Level -eq 'review' }
if ($reviewLevel) {
    [void] $builder.AppendLine('<h2>Review</h2>')
    foreach ($thread in $reviewLevel) {
        [void] $builder.AppendLine('<div class="thread">')
        Write-CommentTree $thread.Comments 0 0 $builder
        [void] $builder.AppendLine('</div>')
    }
}

foreach ($group in ($threads | Where-Object { $_.Level -ne 'review' } | Group-Object ItemPath | Sort-Object Name)) {
    [void] $builder.AppendLine("<h2><code>$(Format-Html $group.Name)</code></h2>")
    foreach ($thread in ($group.Group | Sort-Object { if ($null -eq $_.StartLine) { 0 } else { $_.StartLine } })) {
        [void] $builder.AppendLine('<div class="thread">')
        $anchor = Format-Anchor $thread
        if ($anchor) {
            [void] $builder.AppendLine("<div class=""anchor"">$(Format-Html $anchor)</div>")
        }
        Write-CommentTree $thread.Comments 0 0 $builder
        [void] $builder.AppendLine('</div>')
    }
}

[void] $builder.AppendLine('</body></html>')

$outputDirectory = Split-Path -Parent $OutFile
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

Set-Content -LiteralPath $OutFile -Value $builder.ToString() -Encoding utf8
Write-Host "Wrote $($threads.Count) thread(s) and $commentCount comment(s) to $OutFile."

if ($PassThru) {
    $threads
}
