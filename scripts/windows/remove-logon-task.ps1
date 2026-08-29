[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryPath,

    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$')]
    [string]$TaskName = 'Foundry MCP Host'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'remove-logon-task.ps1 requires Windows.'
}

$taskDescription = 'Foundry MCP per-user broker host launcher (schema 1).'

function Resolve-AbsoluteLocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [ValidateSet('File', 'Directory')][string]$PathType
    )
    if ([string]::IsNullOrWhiteSpace($LiteralPath) -or ($LiteralPath -notmatch '^[a-zA-Z]:[\\/]')) {
        throw "$Purpose must be an explicit absolute local path: $LiteralPath"
    }
    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    $exists = if ($PathType -eq 'File') {
        Test-Path -LiteralPath $fullPath -PathType Leaf
    }
    else {
        Test-Path -LiteralPath $fullPath -PathType Container
    }
    if (-not $exists) {
        throw "$Purpose does not exist: $fullPath"
    }
    return $fullPath
}

function Assert-NoReparsePathComponents {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $candidate = [System.IO.Path]::GetFullPath($LiteralPath)
    $pathRoot = [System.IO.Path]::GetPathRoot($candidate)
    $current = $pathRoot
    $relative = $candidate.Substring($pathRoot.Length)
    $segments = $relative.Split(
        [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )
    foreach ($segment in $segments) {
        $current = Join-Path -Path $current -ChildPath $segment
        if (-not (Test-Path -LiteralPath $current)) {
            break
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing reparse point or junction path component: $current"
        }
    }
}

function Resolve-PrincipalSid {
    param([Parameter(Mandatory = $true)][string]$UserId)
    try {
        if ($UserId -match '^S-\d-(?:\d+-){1,14}\d+$') {
            return (New-Object System.Security.Principal.SecurityIdentifier($UserId)).Value
        }
        $account = New-Object System.Security.Principal.NTAccount($UserId)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    catch {
        throw "Scheduled Task principal cannot be resolved to a Windows SID: $UserId"
    }
}

$resolvedRepository = Resolve-AbsoluteLocalPath -LiteralPath $RepositoryPath -Purpose 'RepositoryPath' -PathType Directory
$launcherPath = Resolve-AbsoluteLocalPath `
    -LiteralPath (Join-Path -Path $resolvedRepository -ChildPath 'scripts\windows\start-host.ps1') `
    -Purpose 'Host launcher' `
    -PathType File
[void](Assert-NoReparsePathComponents -LiteralPath $resolvedRepository)
[void](Assert-NoReparsePathComponents -LiteralPath $launcherPath)

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Output "Per-user logon task '$TaskName' is already absent."
    return
}
if ([string]$task.Description -ne $taskDescription) {
    throw "Refusing to remove task '$TaskName' because it is not an owned Foundry MCP logon launcher."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principalUser = [string]$task.Principal.UserId
if ((Resolve-PrincipalSid -UserId $principalUser) -ne $identity.User.Value) {
    throw "Refusing to remove task '$TaskName' because it belongs to another principal."
}
$actions = @($task.Actions)
if (
    ($actions.Count -ne 1) -or
    ([string]::IsNullOrWhiteSpace([string]$actions[0].Arguments)) -or
    ($actions[0].Arguments.IndexOf($launcherPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)
) {
    throw "Refusing to remove task '$TaskName' because its action is not the expected host launcher."
}

if (-not $PSCmdlet.ShouldProcess($TaskName, "Remove owned per-user logon launcher for '$($identity.Name)'")) {
    Write-Output "Planned: remove owned per-user logon task '$TaskName' for '$($identity.Name)'; no task was changed."
    return
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Removed per-user logon task '$TaskName' for '$($identity.Name)'."
