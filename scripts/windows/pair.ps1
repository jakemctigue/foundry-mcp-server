[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AppDataPath,
    [string]$AdapterCommand = 'foundry-mcp-adapter',
    [string[]]$AdapterArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
if (-not $isWindowsPlatform) {
    throw 'pair.ps1 requires Windows because pairing secrets are protected with current-user DPAPI.'
}

Add-Type -AssemblyName System.Security

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return [System.IO.Path]::GetFullPath($LiteralPath)
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$RootPath
    )
    $candidate = Resolve-FullPath -LiteralPath $LiteralPath
    $root = (Resolve-FullPath -LiteralPath $RootPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (($candidate -ne $root) -and (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing path outside pairing credential directory: $candidate"
    }
    return $candidate
}

function Assert-NoReparsePathComponents {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $candidate = Resolve-FullPath -LiteralPath $LiteralPath
    $pathRoot = [System.IO.Path]::GetPathRoot($candidate)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Path has no filesystem root: $candidate"
    }
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
    return $candidate
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        return
    }
    [void](Assert-NoReparsePathComponents -LiteralPath $LiteralPath)
    $rootItem = Get-Item -LiteralPath $LiteralPath -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse point or junction: $LiteralPath"
    }
    if (-not $rootItem.PSIsContainer) {
        return
    }
    $pending = New-Object System.Collections.Stack
    $pending.Push($rootItem.FullName)
    while ($pending.Count -gt 0) {
        $directory = [string]$pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing reparse point or junction within pairing credential tree: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LiteralPath, $Value, $encoding)
}

function Set-CurrentUserOnlyDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    Set-Acl -LiteralPath $LiteralPath -AclObject $security
}

function Set-CurrentUserOnlyFileAcl {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    Set-Acl -LiteralPath $LiteralPath -AclObject $security
}

function ConvertTo-Base32 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $bits = 0
    $value = 0
    $builder = New-Object System.Text.StringBuilder
    foreach ($byte in $Bytes) {
        $value = ($value -shl 8) -bor $byte
        $bits += 8
        while ($bits -ge 5) {
            [void]$builder.Append($alphabet[($value -shr ($bits - 5)) -band 31])
            $bits -= 5
        }
    }
    if ($bits -gt 0) {
        [void]$builder.Append($alphabet[($value -shl (5 - $bits)) -band 31])
    }
    return $builder.ToString()
}

if ([string]::IsNullOrWhiteSpace($AppDataPath)) {
    $basePath = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($basePath)) {
        $basePath = $env:APPDATA
    }
    if ([string]::IsNullOrWhiteSpace($basePath)) {
        throw 'LOCALAPPDATA or APPDATA must be available, or pass -AppDataPath explicitly.'
    }
    $AppDataPath = Join-Path -Path $basePath -ChildPath 'foundry-mcp'
}

$resolvedAppData = Resolve-FullPath -LiteralPath $AppDataPath
$secretDirectory = Join-Path -Path $resolvedAppData -ChildPath 'secrets'
$secretPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $secretDirectory -ChildPath 'pairing.secret') -RootPath $secretDirectory
$metadataPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $secretDirectory -ChildPath 'pairing.json') -RootPath $secretDirectory

if (-not $PSCmdlet.ShouldProcess($secretPath, 'Generate and persist current-user DPAPI credentials')) {
    Write-Output "Planned: generate and persist current-user credentials at '$secretPath' and print a secret-free client setup."
    return
}

$rawSecret = $null
$protectedSecret = $null
$temporarySecretPath = $null
$temporaryMetadataPath = $null
try {
    [void](Assert-NoReparsePathComponents -LiteralPath $resolvedAppData)
    [void](Assert-NoReparsePathComponents -LiteralPath $secretDirectory)
    [void](Assert-NoReparsePathComponents -LiteralPath $secretPath)
    [void](Assert-NoReparsePathComponents -LiteralPath $metadataPath)
    if (Test-Path -LiteralPath $secretDirectory) {
        Assert-NoReparseTree -LiteralPath $secretDirectory
    }

    New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    [void](Assert-NoReparsePathComponents -LiteralPath $secretDirectory)
    Assert-NoReparseTree -LiteralPath $secretDirectory
    Set-CurrentUserOnlyDirectoryAcl -LiteralPath $secretDirectory

    $operationId = [guid]::NewGuid().ToString('N')
    $temporarySecretPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $secretDirectory -ChildPath ('.pairing.secret.' + $operationId + '.tmp')) -RootPath $secretDirectory
    $temporaryMetadataPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $secretDirectory -ChildPath ('.pairing.json.' + $operationId + '.tmp')) -RootPath $secretDirectory
    [void](Assert-NoReparsePathComponents -LiteralPath $temporarySecretPath)
    [void](Assert-NoReparsePathComponents -LiteralPath $temporaryMetadataPath)

    $rawSecret = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($rawSecret)
    }
    finally {
        $random.Dispose()
    }
    $displaySecret = ConvertTo-Base32 -Bytes $rawSecret
    $protectedSecret = [System.Security.Cryptography.ProtectedData]::Protect(
        $rawSecret,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $metadata = [ordered]@{
        schemaVersion = 1
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        protection = 'DPAPI-CurrentUser'
    }

    [System.IO.File]::WriteAllBytes($temporarySecretPath, $protectedSecret)
    Write-Utf8NoBom -LiteralPath $temporaryMetadataPath -Value ($metadata | ConvertTo-Json)
    Set-CurrentUserOnlyFileAcl -LiteralPath $temporarySecretPath
    Set-CurrentUserOnlyFileAcl -LiteralPath $temporaryMetadataPath

    [void](Assert-NoReparsePathComponents -LiteralPath $secretDirectory)
    Assert-NoReparseTree -LiteralPath $secretDirectory
    [void](Assert-NoReparsePathComponents -LiteralPath $secretPath)
    [void](Assert-NoReparsePathComponents -LiteralPath $metadataPath)
    Move-Item -LiteralPath $temporaryMetadataPath -Destination $metadataPath -Force
    $temporaryMetadataPath = $null
    Move-Item -LiteralPath $temporarySecretPath -Destination $secretPath -Force
    $temporarySecretPath = $null

    $clientConfig = [ordered]@{
        mcpServers = [ordered]@{
            'foundry-vtt' = [ordered]@{
                command = $AdapterCommand
                args = @($AdapterArguments)
            }
        }
    }

    Write-Output "Pairing secret (shown once; paste into the Foundry module): $displaySecret"
    Write-Output 'MCP client configuration (contains no secret):'
    Write-Output ($clientConfig | ConvertTo-Json -Depth 8)
}
finally {
    foreach ($temporaryPath in @($temporarySecretPath, $temporaryMetadataPath)) {
        if (-not [string]::IsNullOrWhiteSpace($temporaryPath) -and (Test-Path -LiteralPath $temporaryPath)) {
            try {
                [void](Assert-NoReparsePathComponents -LiteralPath $temporaryPath)
                $temporaryItem = Get-Item -LiteralPath $temporaryPath -Force
                if (($temporaryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Refusing to remove a reparse point temporary credential: $temporaryPath"
                }
                Remove-Item -LiteralPath $temporaryPath -Force
            }
            catch {
                Write-Warning "Could not safely clean temporary credential '$temporaryPath': $_"
            }
        }
    }
    if ($null -ne $rawSecret) {
        [System.Array]::Clear($rawSecret, 0, $rawSecret.Length)
    }
    if ($null -ne $protectedSecret) {
        [System.Array]::Clear($protectedSecret, 0, $protectedSecret.Length)
    }
}
