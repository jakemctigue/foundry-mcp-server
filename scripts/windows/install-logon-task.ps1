[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryPath,

    [Parameter(Mandatory = $true)]
    [string]$NodePath,

    [Parameter(Mandatory = $true)]
    [string[]]$AllowedOrigin,

    [ValidateSet('127.0.0.1')]
    [string]$ListenHost = '127.0.0.1',

    [ValidateRange(0, 65535)]
    [int]$CompanionPort = 0,

    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$PipeName = 'foundry-mcp',

    [ValidateSet('debug', 'info', 'warn', 'error')]
    [string]$LogLevel = 'info',

    [string]$AppDataPath,

    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$')]
    [string]$TaskName = 'Foundry MCP Host',

    [string]$PowerShellPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'install-logon-task.ps1 requires Windows.'
}

$taskDescription = 'Foundry MCP per-user broker host launcher (schema 1).'

function Resolve-AbsoluteLocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [ValidateSet('Any', 'File', 'Directory')][string]$PathType = 'Any',
        [switch]$AllowMissing
    )
    if ([string]::IsNullOrWhiteSpace($LiteralPath) -or ($LiteralPath -notmatch '^[a-zA-Z]:[\\/]')) {
        throw "$Purpose must be an explicit absolute local path: $LiteralPath"
    }
    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    if (-not $AllowMissing) {
        $exists = switch ($PathType) {
            'File' { Test-Path -LiteralPath $fullPath -PathType Leaf }
            'Directory' { Test-Path -LiteralPath $fullPath -PathType Container }
            default { Test-Path -LiteralPath $fullPath }
        }
        if (-not $exists) {
            throw "$Purpose does not exist: $fullPath"
        }
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

function Resolve-AllowedOrigins {
    param([Parameter(Mandatory = $true)][string[]]$Values)
    $resolved = New-Object System.Collections.Generic.List[string]
    foreach ($candidateValue in $Values) {
        $candidate = $candidateValue.Trim()
        if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.Contains('*')) {
            throw "Each allowed origin must be explicit and cannot contain a wildcard: $candidate"
        }
        $uri = $null
        if (-not [System.Uri]::TryCreate($candidate, [System.UriKind]::Absolute, [ref]$uri)) {
            throw "Invalid allowed origin: $candidate"
        }
        if (($uri.Scheme -ne 'http') -and ($uri.Scheme -ne 'https')) {
            throw "Allowed origin must use http or https: $candidate"
        }
        if (
            -not [string]::IsNullOrEmpty($uri.UserInfo) -or
            -not [string]::IsNullOrEmpty($uri.Query) -or
            -not [string]::IsNullOrEmpty($uri.Fragment) -or
            (($uri.AbsolutePath -ne '/') -and ($uri.AbsolutePath -ne ''))
        ) {
            throw "Allowed origin must contain only scheme, host, and optional port: $candidate"
        }
        $origin = $uri.GetLeftPart([System.UriPartial]::Authority)
        if (-not $resolved.Contains($origin)) {
            [void]$resolved.Add($origin)
        }
    }
    if ($resolved.Count -eq 0) {
        throw 'At least one explicit allowed origin is required.'
    }
    return @($resolved)
}

function Quote-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw 'Task action values cannot contain a double quote.'
    }
    return '"' + $Value + '"'
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

function Assert-OwnedScheduledTask {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)][string]$ExpectedDescription,
        [Parameter(Mandatory = $true)][string]$ExpectedLauncherPath,
        [Parameter(Mandatory = $true)][string]$ExpectedUserSid
    )
    if ([string]$Task.Description -ne $ExpectedDescription) {
        throw "Existing task '$($Task.TaskName)' is not an owned Foundry MCP logon launcher."
    }
    $principalSid = Resolve-PrincipalSid -UserId ([string]$Task.Principal.UserId)
    if ($principalSid -ne $ExpectedUserSid) {
        throw "Existing task '$($Task.TaskName)' belongs to another principal."
    }
    $actions = @($Task.Actions)
    if (
        ($actions.Count -ne 1) -or
        ([string]::IsNullOrWhiteSpace([string]$actions[0].Arguments)) -or
        ($actions[0].Arguments.IndexOf($ExpectedLauncherPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)
    ) {
        throw "Existing task '$($Task.TaskName)' does not use the expected host launcher."
    }
}

$resolvedRepository = Resolve-AbsoluteLocalPath -LiteralPath $RepositoryPath -Purpose 'RepositoryPath' -PathType Directory
$resolvedNode = Resolve-AbsoluteLocalPath -LiteralPath $NodePath -Purpose 'NodePath' -PathType File
$launcherPath = Resolve-AbsoluteLocalPath `
    -LiteralPath (Join-Path -Path $resolvedRepository -ChildPath 'scripts\windows\start-host.ps1') `
    -Purpose 'Host launcher' `
    -PathType File
if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
    $PowerShellPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
}
$resolvedPowerShell = Resolve-AbsoluteLocalPath -LiteralPath $PowerShellPath -Purpose 'PowerShellPath' -PathType File
[void](Assert-NoReparsePathComponents -LiteralPath $resolvedRepository)
[void](Assert-NoReparsePathComponents -LiteralPath $resolvedNode)
[void](Assert-NoReparsePathComponents -LiteralPath $launcherPath)
[void](Assert-NoReparsePathComponents -LiteralPath $resolvedPowerShell)

$resolvedAppData = $null
if (-not [string]::IsNullOrWhiteSpace($AppDataPath)) {
    $resolvedAppData = Resolve-AbsoluteLocalPath -LiteralPath $AppDataPath -Purpose 'AppDataPath' -AllowMissing
    [void](Assert-NoReparsePathComponents -LiteralPath $resolvedAppData)
}
$allowedOrigins = @(Resolve-AllowedOrigins -Values $AllowedOrigin)

$actionArguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (Quote-NativeArgument -Value $launcherPath),
    '-RepositoryPath',
    (Quote-NativeArgument -Value $resolvedRepository),
    '-NodePath',
    (Quote-NativeArgument -Value $resolvedNode),
    '-ListenHost',
    (Quote-NativeArgument -Value $ListenHost),
    '-AllowedOriginsCsv',
    (Quote-NativeArgument -Value ($allowedOrigins -join ',')),
    '-CompanionPort',
    $CompanionPort.ToString([System.Globalization.CultureInfo]::InvariantCulture),
    '-PipeName',
    (Quote-NativeArgument -Value $PipeName),
    '-LogLevel',
    (Quote-NativeArgument -Value $LogLevel)
)
if ($null -ne $resolvedAppData) {
    $actionArguments += @('-AppDataPath', (Quote-NativeArgument -Value $resolvedAppData))
}
$actionArgumentLine = $actionArguments -join ' '
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$identityName = $identity.Name
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Assert-OwnedScheduledTask `
        -Task $existingTask `
        -ExpectedDescription $taskDescription `
        -ExpectedLauncherPath $launcherPath `
        -ExpectedUserSid $identity.User.Value
}

if (-not $PSCmdlet.ShouldProcess($TaskName, "Register limited per-user logon launcher for '$identityName'")) {
    Write-Output "Planned: register per-user logon task '$TaskName' for '$identityName' using '$resolvedPowerShell', launcher '$launcherPath', Node '$resolvedNode', loopback '$ListenHost', and origins $($allowedOrigins -join ', '); no task was changed."
    return
}

$action = New-ScheduledTaskAction `
    -Execute $resolvedPowerShell `
    -Argument $actionArgumentLine `
    -WorkingDirectory $resolvedRepository
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identityName
$principal = New-ScheduledTaskPrincipal `
    -UserId $identityName `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description $taskDescription `
    -Force | Out-Null

Write-Output "Installed per-user logon task '$TaskName' for '$identityName'. It starts only at that user's interactive logon and uses a limited principal."
