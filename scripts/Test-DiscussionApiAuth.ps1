<#
.SYNOPSIS
    Determines which authentication methods the discussion API accepts.

.DESCRIPTION
    An Azure DevOps extension can only obtain a delegated access token, and the discussion API
    rejects those with TF400813 while accepting the very same token for TFVC endpoints. This script
    isolates why, by trying the same request four ways:

      1. Discussion API with Windows integrated authentication  (known to work; the control)
      2. Discussion API with a personal access token
      3. TFVC API with the same personal access token           (proves the token itself is valid)
      4. Discussion API with a deliberately invalid token       (proves a 401 is reachable, so a
                                                                 success in step 2 is meaningful)

    What the results mean:

      * Step 2 succeeds -> the endpoint accepts token authentication and refuses *delegated
        extension* identities specifically. An in-browser extension could then work by having each
        user supply their own personal access token.
      * Step 2 fails while steps 1 and 3 succeed -> the endpoint accepts only Windows
        authentication. No browser extension can reach it, and a server-side component is required.

    The token is read as a SecureString and is never written to output or to disk.

.PARAMETER CollectionUri
    Root URI of the team project collection, for example https://tfs.example.com/DefaultCollection.

.PARAMETER WorkItemId
    ID of a Code Review Request work item that has published comments.

.PARAMETER PersonalAccessToken
    A personal access token for the signed-in user. Prompted for securely when omitted. Create one
    from the web UI under user settings, with full access or at least work item and code scopes.

.EXAMPLE
    .\Test-DiscussionApiAuth.ps1 -CollectionUri https://tfs.example.com/DefaultCollection -WorkItemId 1234
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
    [System.Security.SecureString] $PersonalAccessToken
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PersonalAccessToken) {
    $PersonalAccessToken = Read-Host -AsSecureString 'Personal access token'
}

$collectionRoot = $CollectionUri.TrimEnd('/')
$discussionUri = "$collectionRoot/_apis/discussion/threads?workItemId=$WorkItemId&api-version=3.0-preview.1"
$tfvcUri = "$collectionRoot/_apis/tfvc/shelvesets?api-version=3.0&`$top=1"

$allowUnencrypted = (([uri] $collectionRoot).Scheme -ne 'https') -and ($PSVersionTable.PSEdition -eq 'Core')
if ($allowUnencrypted) {
    Write-Warning "$collectionRoot is not HTTPS; credentials will be sent over an unencrypted connection."
}

function New-BasicAuthorizationHeader([System.Security.SecureString] $token) {
    # A personal access token is sent as the password of an empty user name.
    $plain = [System.Net.NetworkCredential]::new('', $token).Password
    $bytes = [System.Text.Encoding]::ASCII.GetBytes(":$plain")
    return 'Basic ' + [Convert]::ToBase64String($bytes)
}

function Invoke-Probe {
    param (
        [string] $Label,
        [string] $Uri,
        [switch] $UseWindowsAuth,
        [string] $AuthorizationHeader
    )

    $arguments = @{ Uri = $Uri; ErrorAction = 'Stop' }
    if ($UseWindowsAuth) {
        $arguments['UseDefaultCredentials'] = $true
    }
    if ($AuthorizationHeader) {
        $arguments['Headers'] = @{ Authorization = $AuthorizationHeader }
    }
    if ($allowUnencrypted) {
        $arguments['AllowUnencryptedAuthentication'] = $true
    }

    $progressPreferenceBackup = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        $response = Invoke-WebRequest @arguments
        $detail = ''
        try {
            $parsed = $response.Content | ConvertFrom-Json
            if ($parsed.PSObject.Properties['count']) { $detail = " ($($parsed.count) item(s))" }
        }
        catch {
            # A non-JSON body is still a successful status; the status is what matters here.
        }
        Write-Host ("  {0,-52} {1}{2}" -f $Label, $response.StatusCode, $detail) -ForegroundColor Green
        return $true
    }
    catch {
        $status = if ($_.Exception.Response) { [int] $_.Exception.Response.StatusCode } else { 'error' }
        $message = ''
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            try {
                $problem = $_.ErrorDetails.Message | ConvertFrom-Json
                if ($problem.PSObject.Properties['message']) { $message = " $($problem.message)" }
            }
            catch {
                $message = ''
            }
        }
        Write-Host ("  {0,-52} {1}{2}" -f $Label, $status, $message) -ForegroundColor Yellow
        return $false
    }
    finally {
        $ProgressPreference = $progressPreferenceBackup
    }
}

$authorization = New-BasicAuthorizationHeader $PersonalAccessToken
$invalidAuthorization = New-BasicAuthorizationHeader (ConvertTo-SecureString 'not-a-real-token' -AsPlainText -Force)

Write-Host "Probing $collectionRoot" -ForegroundColor Cyan
$windowsAuthWorks = Invoke-Probe -Label '1. discussion + Windows auth (control)' -Uri $discussionUri -UseWindowsAuth
$patOnDiscussion = Invoke-Probe -Label '2. discussion + personal access token' -Uri $discussionUri -AuthorizationHeader $authorization
$patOnTfvc = Invoke-Probe -Label '3. tfvc + personal access token (control)' -Uri $tfvcUri -AuthorizationHeader $authorization
$invalidRejected = -not (Invoke-Probe -Label '4. discussion + invalid token (control)' -Uri $discussionUri -AuthorizationHeader $invalidAuthorization)

Write-Host ''
if ($patOnDiscussion -and $invalidRejected) {
    Write-Host 'The discussion API accepts token authentication.' -ForegroundColor Green
    Write-Host 'It is refusing delegated extension identities specifically, not tokens in general.'
    Write-Host 'A browser extension could work if each user supplies their own personal access token.'
}
elseif ($patOnDiscussion -and -not $invalidRejected) {
    Write-Host 'Inconclusive: the invalid token was also accepted, so the endpoint is probably' -ForegroundColor Yellow
    Write-Host 'falling back to Windows authentication and ignoring the Authorization header.'
}
elseif ($windowsAuthWorks -and $patOnTfvc) {
    Write-Host 'The discussion API accepts only Windows authentication.' -ForegroundColor Yellow
    Write-Host 'The token is valid (TFVC accepted it) and Windows auth works, so no browser-side'
    Write-Host 'credential can reach this endpoint. A server-side component is required.'
}
else {
    Write-Host 'Inconclusive. Check that the token is valid and that the work item ID is a code review.' -ForegroundColor Yellow
}
