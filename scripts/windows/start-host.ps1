[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryPath,

    [Parameter(Mandatory = $true)]
    [string]$NodePath,

    [ValidateSet('127.0.0.1')]
    [string]$ListenHost = '127.0.0.1',

    [Parameter(Mandatory = $true)]
    [string]$AllowedOriginsCsv,

    [ValidateRange(0, 65535)]
    [int]$CompanionPort = 0,

    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$PipeName = 'foundry-mcp',

    [ValidateSet('debug', 'info', 'warn', 'error')]
    [string]$LogLevel = 'info',

    [string]$AppDataPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'start-host.ps1 requires Windows.'
}

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
    param([Parameter(Mandatory = $true)][string]$Csv)
    $resolved = New-Object System.Collections.Generic.List[string]
    foreach ($candidateValue in $Csv.Split(',')) {
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

$resolvedRepository = Resolve-AbsoluteLocalPath -LiteralPath $RepositoryPath -Purpose 'RepositoryPath' -PathType Directory
$resolvedNode = Resolve-AbsoluteLocalPath -LiteralPath $NodePath -Purpose 'NodePath' -PathType File
$hostEntry = Resolve-AbsoluteLocalPath `
    -LiteralPath (Join-Path -Path $resolvedRepository -ChildPath 'packages\host\dist\index.js') `
    -Purpose 'Built host entry point' `
    -PathType File
$hostRunner = Resolve-AbsoluteLocalPath `
    -LiteralPath (Join-Path -Path $resolvedRepository -ChildPath 'scripts\windows\host-process.mjs') `
    -Purpose 'Host process runner' `
    -PathType File
[void](Assert-NoReparsePathComponents -LiteralPath $resolvedRepository)
[void](Assert-NoReparsePathComponents -LiteralPath $resolvedNode)
[void](Assert-NoReparsePathComponents -LiteralPath $hostEntry)
[void](Assert-NoReparsePathComponents -LiteralPath $hostRunner)

$resolvedAppData = $null
if (-not [string]::IsNullOrWhiteSpace($AppDataPath)) {
    $resolvedAppData = Resolve-AbsoluteLocalPath -LiteralPath $AppDataPath -Purpose 'AppDataPath' -AllowMissing
    [void](Assert-NoReparsePathComponents -LiteralPath $resolvedAppData)
}
$allowedOrigins = @(Resolve-AllowedOrigins -Csv $AllowedOriginsCsv)
$portDescription = if ($CompanionPort -eq 0) { 'dynamic' } else { $CompanionPort.ToString() }

if (-not $PSCmdlet.ShouldProcess("${ListenHost}:$portDescription", "Start Foundry MCP host from '$resolvedRepository' with Node '$resolvedNode'")) {
    Write-Output "Planned: start the Foundry MCP host with Node '$resolvedNode' from '$resolvedRepository' on ${ListenHost}:$portDescription for origins $($allowedOrigins -join ', '); no process or runtime data was created."
    return
}

$launchConfiguration = [ordered]@{
    hostEntry = $hostEntry
    appDataPath = $resolvedAppData
    listenHost = $ListenHost
    port = $CompanionPort
    pipeName = $PipeName
    logLevel = $LogLevel
    allowedOrigins = $allowedOrigins
}
$priorLaunchConfiguration = $env:FOUNDRY_MCP_HOST_LAUNCH
$env:FOUNDRY_MCP_HOST_LAUNCH = $launchConfiguration | ConvertTo-Json -Depth 4 -Compress

try {
    & $resolvedNode $hostRunner
    if ($LASTEXITCODE -ne 0) {
        throw "Foundry MCP host process exited with code $LASTEXITCODE."
    }
}
finally {
    if ($null -eq $priorLaunchConfiguration) {
        Remove-Item -LiteralPath 'Env:\FOUNDRY_MCP_HOST_LAUNCH' -ErrorAction SilentlyContinue
    }
    else {
        $env:FOUNDRY_MCP_HOST_LAUNCH = $priorLaunchConfiguration
    }
}
